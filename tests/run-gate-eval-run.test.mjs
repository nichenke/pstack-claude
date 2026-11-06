import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(args[args.indexOf("--add-dir") + 1]).toMatch(/\/slugkit-[0-9a-f]{6}\/\.git$/);
    expect(args.at(-1)).toStartWith("$pstack:poteto-mode ");
    const run = join(b.root, "batch/runs/slugkit-codex-native-1");
    expect(existsSync(join(run, "rollout.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(join(run, "score.json"), "utf8"))).toMatchObject({ runtime: "codex", outcome: "clean", tokens: { output_tokens: 3 }, budget: null });

    const hook = batch("todo-hook");
    expect(runOne(hook, "codex", "todo-hook").status).toBe(0);
    expect(argsOf(hook, "codex")).not.toContain("tools.update_plan.enabled=true");
  });

  // Replaces a stub's body, keeping the preamble that records its arguments and environment.
  const restub = (b, name, body) => stub(b.root, name, body);
  const scoreOf = (b, runtime, arm) => JSON.parse(readFileSync(join(b.root, `batch/runs/slugkit-${runtime}-${arm}-1/score.json`), "utf8"));
  const tmpLeft = (b) => readdirSync(join(b.env.WORK_ROOT, ".tmp"));

  test("scores a codex run that died before it made a sessions dir as an error, and cleans up", () => {
    const b = batch("todo");
    rmSync(join(b.home, "sessions"), { recursive: true });
    restub(b, "codex", "echo 'Error: bad config' >&2; exit 1");
    const r = runOne(b, "codex", "todo");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("run-one: no rollout for thread ''");
    expect(scoreOf(b, "codex", "todo")).toMatchObject({ exit: 1, outcome: "error", gateBlocks: null, delegates: null });
    expect(tmpLeft(b)).toEqual([]);
  });

  test("scores a codex stream cut off mid-line by a timeout as a timeout", () => {
    const b = batch("todo-hook");
    restub(b, "codex", `echo '{"type":"thread.started","thread_id":"th1"}'; printf '{"type":"item.completed","item":{"ty'; exit 124`);
    expect(runOne(b, "codex", "todo-hook").status).toBe(0);
    expect(scoreOf(b, "codex", "todo-hook")).toMatchObject({ exit: 124, outcome: "timeout", gateHeld: null });
  });

  test("scores a codex run that left a spawned delegate running as delegate-in-flight, from its copied rollout", () => {
    const b = batch("native");
    const day = "$CODEX_HOME/sessions/2026/11/05";
    const meta = (id, parent) =>
      JSON.stringify({ type: "session_meta", payload: { id, parent_thread_id: parent, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } } } });
    restub(
      b,
      "codex",
      [
        `echo '{"type":"thread.started","thread_id":"th1"}'`,
        `echo '{"type":"turn.completed","usage":{"output_tokens":3}}'`,
        `printf '%s\\n' '{"type":"session_meta","payload":{"id":"th1"}}' '{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","arguments":"{}"}}' >"${day}/rollout-x-th1.jsonl"`,
        `printf '%s\\n' '${meta("ch1", "th1")}' '{"type":"event_msg","payload":{"type":"task_started"}}' >"${day}/rollout-x-ch1.jsonl"`,
      ].join("\n"),
    );
    expect(runOne(b, "codex", "native").status).toBe(0);
    const run = join(b.root, "batch/runs/slugkit-codex-native-1");
    expect(scoreOf(b, "codex", "native")).toMatchObject({ outcome: "delegate-in-flight", delegates: 1, delegatesInFlight: 1 });
    expect(readdirSync(join(run, "children"))).toEqual(["rollout-x-ch1.jsonl"]);
    expect(tmpLeft(b)).toEqual([]);
    rmSync(join(b.home, "sessions"), { recursive: true });
    expect(spawnSync("node", [join(evalDir, "score.mjs"), run], { encoding: "utf8" }).status).toBe(0);
    expect(readdirSync(join(run, "children"))).toEqual(["rollout-x-ch1.jsonl"]);
    expect(scoreOf(b, "codex", "native")).toMatchObject({ outcome: "delegate-in-flight", delegatesInFlight: 1 });
  });

  test("scores a native claude run's gates and fidelity from its task list", () => {
    const b = batch("native");
    const plugin = join(import.meta.dir, "../plugins/pstack");
    const openRun = join(plugin, "skills/poteto-mode/scripts/open-run.mjs");
    const steps = spawnSync("node", [openRun, "--dry-run", "bug-fix"], { encoding: "utf8" }).stdout.split("\n").filter((l) => l.startsWith("- [ ] ")).map((l) => l.slice(6));
    let n = 0;
    const use = (name, input) => ({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: `t${++n}`, name, input }] } });
    const result = (text) => ({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: `t${n}`, content: [{ type: "text", text }] }] } });
    const events = [
      { type: "system", subtype: "init", session_id: "s1", plugins: [{ name: "pstack", path: plugin }] },
      use("Bash", { command: `node ${openRun} --dry-run bug-fix` }),
      ...steps.flatMap((subject, i) => [use("TaskCreate", { subject, description: "" }), result(`Task #${i + 1} created successfully: ${subject}`)]),
      ...steps.map((subject, i) => use("TaskUpdate", { taskId: String(i + 1), status: "completed", ...(/deslop/.test(subject) ? { description: "skip: one-line diff" } : {}) })),
      { type: "result", is_error: false, num_turns: 3 },
    ];
    const stream = join(b.root, "native.jsonl");
    writeFileSync(stream, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    restub(b, "claude", `cat '${stream}'`);
    expect(runOne(b, "claude", "native").status).toBe(0);
    const score = scoreOf(b, "claude", "native");
    expect(score.fidelity).toEqual({ steps: steps.length, matched: steps.length });
    expect(score).toMatchObject({ list: "task-tool", playbook: "bug-fix", pluginOk: true, taskList: { total: steps.length, open: 0, skipped: 1 } });
    expect(score.gates).toMatchObject({ deslop: "skipped", noComments: "claimed" });
  });

  test("runs both runtimes under macOS's stock bash 3.2", () => {
    if (!existsSync("/bin/bash")) return;
    for (const runtime of ["claude", "codex"]) {
      const b = batch("todo");
      const r = spawnSync("/bin/bash", [join(evalDir, "run-one.sh"), join(b.root, "batch"), "slugkit", runtime, "todo", "1"], { encoding: "utf8", env: { ...clean, ...b.env } });
      expect(r.status).toBe(0);
      expect(scoreOf(b, runtime, "todo").outcome).toBe("clean");
    }
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
