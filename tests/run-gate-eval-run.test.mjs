import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evalDir = join(import.meta.dir, "../evals/run-gate");
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !["TASKS", "ARMS", "RUNTIMES", "BUDGET_USD", "RUN_MINUTES", "PARALLEL", "CODEX_HOOKS"].includes(key)),
);
const sh = (script, args, env = {}) =>
  spawnSync("bash", [join(evalDir, script), ...args], { encoding: "utf8", env: { ...clean, ...env } });
const dryRun = (env, ...args) => sh("run.sh", ["--dry-run", ...args], env);
const summary = (r) => r.stdout.trim().split("\n").at(-1);

describe("run.sh --dry-run", () => {
  const jobs = (r) => r.stdout.split("\n").filter((line) => line.startsWith("job "));

  test("selects the named tasks, runtimes and arms and prices the claude runs from each task's settings", () => {
    const r = dryRun({ TASKS: "slugkit logsift", RUNTIMES: "claude", ARMS: "native todo-hook" }, "2");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slugkit 45 10\nlogsift 90 30\n");
    expect(summary(r)).toBe(
      "8 runs (8 claude, 0 codex) on arms native todo-hook, 3 at a time; cost ceiling $160.00 for claude; codex uncapped in USD, at most 0 minutes",
    );
  });

  test("defaults to every task on both runtimes and all three arms, and lists every job", () => {
    const r = dryRun({}, "1");
    expect(summary(r)).toBe(
      "24 runs (12 claude, 12 codex) on arms native todo todo-hook, 3 at a time; cost ceiling $180.00 for claude; codex uncapped in USD, at most 675 minutes",
    );
    const combos = new Set(jobs(r).map((line) => line.split(" ").slice(2, 4).join(" ")));
    expect(jobs(r)).toHaveLength(24);
    expect([...combos].sort()).toEqual(["claude native", "claude todo", "claude todo-hook", "codex native", "codex todo", "codex todo-hook"]);
  });

  test("--smoke is one slugkit run per runtime and arm", () => {
    const r = dryRun({ TASKS: "logsift" }, "--smoke");
    expect(r.status).toBe(0);
    expect(jobs(r).sort()).toEqual(
      ["claude native", "claude todo", "claude todo-hook", "codex native", "codex todo", "codex todo-hook"].map((c) => `job slugkit ${c} 1`),
    );
  });

  test("an exported budget wins over task.env", () => {
    expect(summary(dryRun({ TASKS: "logsift", RUNTIMES: "claude", ARMS: "todo" , BUDGET_USD: "2.5" }, "1"))).toContain("cost ceiling $2.50");
  });

  test("runs under macOS's stock bash 3.2", () => {
    if (!existsSync("/bin/bash")) return;
    const r = spawnSync("/bin/bash", [join(evalDir, "run.sh"), "--dry-run", "1"], { encoding: "utf8", env: clean });
    expect(r.stderr).toBe("");
    expect(jobs(r)).toHaveLength(24);
  });

  const refusals = {
    "an unknown task": [{ TASKS: "nope" }, "unknown task 'nope'"],
    "a path for a task": [{ TASKS: "../tasks/slugkit" }, "unknown task"],
    "an unknown arm": [{ ARMS: "hook" }, "unknown arm 'hook'"],
    "an arm named twice": [{ ARMS: "todo todo" }, "names an arm twice"],
    "an unknown runtime": [{ RUNTIMES: "gemini" }, "unknown runtime 'gemini'"],
    "a runtime named twice": [{ RUNTIMES: "codex codex" }, "names a runtime twice"],
    "an empty selection": [{ TASKS: " " }, "must each name at least one"],
    "zero reps": [{}, "reps must be", "0"],
  };
  for (const [name, [env, message, reps = "1"]] of Object.entries(refusals)) {
    test(`refuses ${name}`, () => {
      const r = dryRun(env, reps);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stdout).toBe("");
    });
  }
});

describe("run.sh", () => {
  test("refuses a codex batch unless the operator opts in to bypassing hook trust", () => {
    const r = sh("run.sh", ["1"], { RUNTIMES: "codex", TASKS: "slugkit", WORK_ROOT: mkdtempSync(join(tmpdir(), "wr-")) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CODEX_HOOKS=bypass");
  });
});

describe("run-one.sh", () => {
  // Stub runtimes record the environment and arguments they were started with, then print a stream.
  const stub = (dir, name, stream) => {
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >"$STUB_LOG.${name}.args"\nenv >"$STUB_LOG.${name}.env"\n${stream}\n`,
    );
    chmodSync(file, 0o755);
    return file;
  };

  function batch(arm) {
    const root = mkdtempSync(join(tmpdir(), "run-one-"));
    const home = join(root, "home");
    mkdirSync(join(home, "sessions/2026/11/05"), { recursive: true });
    mkdirSync(join(root, "batch/runs"), { recursive: true });
    const plugin = join(import.meta.dir, "../plugins/pstack");
    writeFileSync(join(root, "batch/arms.tsv"), `${arm} ab12 ${plugin} ${home} ${plugin}\n`);
    const claude = stub(root, "claude", `echo '{"type":"system","subtype":"init","session_id":"s1"}'; echo '{"type":"result","is_error":false}'`);
    const codex = stub(
      root,
      "codex",
      `echo '{"type":"thread.started","thread_id":"th1"}'; echo '{"type":"turn.completed","usage":{"output_tokens":3}}'; echo '{"type":"session_meta","payload":{"id":"th1"}}' >"$CODEX_HOME/sessions/2026/11/05/rollout-x-th1.jsonl"`,
    );
    return { root, home, env: { WORK_ROOT: join(root, "work"), CLAUDE_BIN: claude, CODEX_BIN: codex, STUB_LOG: join(root, "log"), CODEX_HOOKS: "bypass", CLAUDE_CODE_SESSION_ID: "outer", CODEX_THREAD_ID: "outer" } };
  }
  const runOne = (b, runtime, arm) => sh("run-one.sh", [join(b.root, "batch"), "slugkit", runtime, arm, "1"], b.env);
  const envOf = (b, name) => Object.fromEntries(readFileSync(`${b.env.STUB_LOG}.${name}.env`, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const argsOf = (b, name) => readFileSync(`${b.env.STUB_LOG}.${name}.args`, "utf8").trim().split("\n");

  test("gives each claude run its own TMPDIR, removed afterwards, and task tools only on the native arm", () => {
    const b = batch("native");
    expect(runOne(b, "claude", "native").status).toBe(0);
    const first = envOf(b, "claude");
    expect(first.TMPDIR).toStartWith(join(b.env.WORK_ROOT, ".tmp/"));
    expect(existsSync(first.TMPDIR)).toBe(false);
    expect(first.CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe("1");
    expect(first.CODEX_THREAD_ID).toBeUndefined();
    expect(runOne(b, "claude", "native").status).toBe(0);
    expect(envOf(b, "claude").TMPDIR).not.toBe(first.TMPDIR);
    const score = JSON.parse(readFileSync(join(b.root, "batch/runs/slugkit-claude-native-1/score.json"), "utf8"));
    expect(score).toMatchObject({ runtime: "claude", arm: "native", exit: 0, outcome: "clean" });

    const todo = batch("todo");
    expect(runOne(todo, "claude", "todo").status).toBe(0);
    expect(envOf(todo, "claude").CLAUDE_CODE_ENABLE_TODO_TOOLS).toBeUndefined();
  });

  test("runs codex in the arm's home with update_plan only on the native arm, the trust bypass, and no Claude session id", () => {
    const b = batch("native");
    expect(runOne(b, "codex", "native").status).toBe(0);
    const env = envOf(b, "codex");
    expect(env.CODEX_HOME).toBe(b.home);
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.TMPDIR).toStartWith(join(b.env.WORK_ROOT, ".tmp/"));
    const args = argsOf(b, "codex");
    expect(args).toContain("tools.update_plan.enabled=true");
    expect(args).toContain("--dangerously-bypass-hook-trust");
    expect(args.at(-1)).toStartWith("$pstack:poteto-mode ");
    const run = join(b.root, "batch/runs/slugkit-codex-native-1");
    expect(existsSync(join(run, "rollout.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(run, "score.json"), "utf8"))).toMatchObject({ runtime: "codex", outcome: "clean", tokens: { output_tokens: 3 }, budget: null });

    const hook = batch("todo-hook");
    expect(runOne(hook, "codex", "todo-hook").status).toBe(0);
    expect(argsOf(hook, "codex")).not.toContain("tools.update_plan.enabled=true");
  });

  test("records a timed-out run as a timeout", () => {
    const b = batch("todo");
    writeFileSync(b.env.CLAUDE_BIN, "#!/usr/bin/env bash\nexit 124\n");
    expect(runOne(b, "claude", "todo").status).toBe(0);
    expect(JSON.parse(readFileSync(join(b.root, "batch/runs/slugkit-claude-todo-1/score.json"), "utf8")).outcome).toBe("timeout");
  });
});

describe("task-settings.sh", () => {
  const task = (env) => {
    const dir = mkdtempSync(join(tmpdir(), "task-"));
    if (env !== undefined) writeFileSync(join(dir, "task.env"), env);
    return dir;
  };

  test("defaults without a task.env, reads one, and lets the environment win", () => {
    expect(sh("task-settings.sh", [task()]).stdout).toBe("45 10\n");
    expect(sh("task-settings.sh", [task("RUN_MINUTES=90\n\nBUDGET_USD=30")]).stdout).toBe("90 30\n");
    expect(sh("task-settings.sh", [task("RUN_MINUTES=90\n")], { RUN_MINUTES: "5" }).stdout).toBe("5 10\n");
  });

  for (const [name, env] of Object.entries({
    "an unknown key": "MODEL=haiku\n",
    "a fractional minute count": "RUN_MINUTES=1.5\n",
    "a zero budget": "BUDGET_USD=0.0\n",
    "a budget with a leading zero": "BUDGET_USD=07\n",
  })) {
    test(`exits 2 on ${name}`, () => expect(sh("task-settings.sh", [task(env)]).status).toBe(2));
  }
});
