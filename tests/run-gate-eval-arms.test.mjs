import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strip = join(import.meta.dir, "../evals/run-gate/strip-run-gate.sh");
const SENTENCE = " On Claude Code the plugin's Stop hook runs the same check and holds the first stop while a line is open and no background agent or workflow is still running.";
const STEP = "4. Before the final reply, run `open-run.mjs --check` and resolve every line it prints.";
const sessionStart = { matcher: "startup", hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" claude' }] };
const runGate = { hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/run-gate.mjs"' }] };

function plugin({ hooks = { SessionStart: [sessionStart], Stop: [runGate] }, skill = `${STEP}${SENTENCE}\n`, extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "arm-"));
  const files = {
    "hooks/hooks.json": JSON.stringify({ hooks }, null, 2),
    "hooks/run-gate.mjs": "// Stop hook\n",
    "skills/poteto-mode/SKILL.md": skill,
    ...extra,
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

const run = (...args) => spawnSync("bash", [strip, ...args], { encoding: "utf8" });
const read = (root, file) => readFileSync(join(root, file), "utf8");

describe("strip-run-gate.sh", () => {
  test("unregisters the hook and deletes the sentence, keeping the rest", () => {
    const root = plugin();
    const r = run(root);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(read(root, "hooks/hooks.json"))).toEqual({ hooks: { SessionStart: [sessionStart] } });
    expect(read(root, "skills/poteto-mode/SKILL.md")).toBe(`${STEP}\n`);
  });

  test("keeps another Stop hook registered beside it", () => {
    const other = { hooks: [{ type: "command", command: "node lint.mjs" }] };
    const root = plugin({ hooks: { Stop: [other, runGate] } });
    expect(run(root).status).toBe(0);
    expect(JSON.parse(read(root, "hooks/hooks.json"))).toEqual({ hooks: { Stop: [other] } });
  });

  const refusals = {
    "a reworded sentence": { skill: `${STEP} The Stop hook now runs the same check.\n` },
    "the sentence twice": { skill: `${STEP}${SENTENCE}\n${SENTENCE}\n` },
    "no Stop hook": { hooks: { SessionStart: [sessionStart] } },
    "the hook under another event": { hooks: { SubagentStop: [runGate] } },
  };
  for (const [name, shape] of Object.entries(refusals)) {
    test(`refuses ${name} and changes nothing`, () => {
      const root = plugin(shape);
      const before = [read(root, "hooks/hooks.json"), read(root, "skills/poteto-mode/SKILL.md")];
      const r = run(root);
      expect(r.status).toBe(1);
      expect(r.stderr).toStartWith("strip-run-gate: expected");
      expect([read(root, "hooks/hooks.json"), read(root, "skills/poteto-mode/SKILL.md")]).toEqual(before);
    });
  }

  test("fails when another file still names the hook after stripping", () => {
    const root = plugin({ extra: { "skills/figure-it-out/SKILL.md": "The Stop hook holds the stop.\n" } });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("skills/figure-it-out/SKILL.md");
  });

  test("--verify passes an untouched tree, refuses a stripped one, and writes nothing", () => {
    const root = plugin();
    const before = read(root, "hooks/hooks.json");
    expect(run("--verify", root).status).toBe(0);
    expect(read(root, "hooks/hooks.json")).toBe(before);
    expect(run(root).status).toBe(0);
    expect(run("--verify", root).status).toBe(1);
  });
});

const evalDir = join(import.meta.dir, "../evals/run-gate");
const node = (script, ...args) => spawnSync("node", [join(evalDir, script), ...args], { encoding: "utf8" });
const realSkill = readFileSync(join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/SKILL.md"), "utf8");
const strippedSkill = realSkill.replace(SENTENCE, "");

describe("native-arm.mjs", () => {
  test("rewrites the todolist paragraph and steps 2 to 4 for the native task tool, keeping the rest", () => {
    const root = plugin({ skill: strippedSkill });
    const r = node("native-arm.mjs", root);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const skill = read(root, "skills/poteto-mode/SKILL.md");
    expect(skill).toContain("`TaskCreate` and `TaskUpdate` on Claude Code, and `update_plan` on Codex");
    expect(skill).toContain("`select:TaskCreate,TaskUpdate`");
    expect(skill).toContain("open-run.mjs --dry-run <playbook>`, which writes nothing");
    expect(skill).not.toContain("open-run.mjs --check");
    expect(skill).not.toContain("`todo.md`");
    expect(skill).toContain("1. Match the task to a playbook");
  });

  for (const [name, skill] of Object.entries({
    "a reworded todolist paragraph": strippedSkill.replace("The todolist is the uncommitted `todo.md`", "The list is the uncommitted `todo.md`"),
    "a missing step": strippedSkill.replace("3. Work from the todolist.", "3. Work from it."),
    "steps that are not consecutive": strippedSkill.replace("3. Work from the todolist.", "\n3. Work from the todolist."),
  })) {
    test(`refuses ${name} and changes nothing`, () => {
      const root = plugin({ skill });
      const r = node("native-arm.mjs", root);
      expect(r.status).toBe(1);
      expect(r.stderr).toStartWith("native-arm: expected");
      expect(read(root, "skills/poteto-mode/SKILL.md")).toBe(skill);
    });
  }
});

describe("codex-stop.mjs", () => {
  const codexHooks = { hooks: { SessionStart: [sessionStart] } };
  const withCodex = (codex = codexHooks) => plugin({ extra: { "hooks/codex-hooks.json": JSON.stringify(codex) } });

  test("copies the Claude Code run-gate entry into codex-hooks.json, keeping its SessionStart hook", () => {
    const root = withCodex();
    expect(node("codex-stop.mjs", root).status).toBe(0);
    expect(JSON.parse(read(root, "hooks/codex-hooks.json"))).toEqual({ hooks: { SessionStart: [sessionStart], Stop: [runGate] } });
    expect(node("codex-stop.mjs", "--absent", root).status).toBe(1);
  });

  test("--absent passes a tree with no Codex Stop hook and writes nothing", () => {
    const root = withCodex();
    expect(node("codex-stop.mjs", "--absent", root).status).toBe(0);
    expect(JSON.parse(read(root, "hooks/codex-hooks.json"))).toEqual(codexHooks);
  });

  test("refuses a tree whose hooks.json no longer registers run-gate", () => {
    const root = plugin({ hooks: { SessionStart: [sessionStart] }, extra: { "hooks/codex-hooks.json": JSON.stringify(codexHooks) } });
    const r = node("codex-stop.mjs", root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("expected one Stop entry");
  });
});

describe("build-arms.sh", () => {
  const hooks = (dir, file) => JSON.parse(readFileSync(join(dir, "hooks", file), "utf8")).hooks;
  const build = (args, env = {}) =>
    spawnSync("bash", [join(evalDir, "build-arms.sh"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const rows = (stdout) => Object.fromEntries(stdout.trim().split("\n").map((line) => line.split(" ")).map(([arm, ...rest]) => [arm, rest]));

  test("builds native, todo and todo-hook from HEAD with the hooks each arm isolates", () => {
    const dest = mkdtempSync(join(tmpdir(), "arms-"));
    const r = build([dest]);
    expect(r.stderr).toBe("");
    const arms = rows(r.stdout);
    expect(Object.keys(arms)).toEqual(["native", "todo", "todo-hook"]);
    for (const [, [label, path, home, installed]] of Object.entries(arms)) {
      expect(label).toMatch(/^[0-9a-f]{4}$/);
      expect(path).toBe(join(dest, label, "plugins/pstack"));
      expect([home, installed]).toEqual(["-", "-"]);
    }
    const [native, todo, hook] = ["native", "todo", "todo-hook"].map((arm) => arms[arm][1]);
    expect(hooks(native, "hooks.json").Stop).toBeUndefined();
    expect(hooks(todo, "hooks.json").Stop).toBeUndefined();
    expect(hooks(native, "codex-hooks.json").Stop).toBeUndefined();
    expect(hooks(todo, "codex-hooks.json").Stop).toBeUndefined();
    expect(hooks(hook, "codex-hooks.json").Stop).toEqual(hooks(hook, "hooks.json").Stop);
    expect(readFileSync(join(native, "skills/poteto-mode/SKILL.md"), "utf8")).toContain("`update_plan` on Codex");
    expect(readFileSync(join(todo, "skills/poteto-mode/SKILL.md"), "utf8")).toContain("open-run.mjs --check");
  });

  test("--codex installs each arm into its own Codex home from a local marketplace, with auth linked", () => {
    const dest = mkdtempSync(join(tmpdir(), "arms-"));
    const auth = mkdtempSync(join(tmpdir(), "auth-"));
    writeFileSync(join(auth, "auth.json"), "{}");
    const codex = join(auth, "codex");
    writeFileSync(
      codex,
      `#!/usr/bin/env bash
case "$2 $3" in
  "marketplace add") echo "$4" >"$CODEX_HOME/.root" ;;
  "add pstack@local") mkdir -p "$CODEX_HOME/plugins/cache/local/pstack/9.9" && cp -R "$(cat "$CODEX_HOME/.root")/plugins/pstack/." "$CODEX_HOME/plugins/cache/local/pstack/9.9" ;;
  *) exit 3 ;;
esac
`,
    );
    chmodSync(codex, 0o755);
    const r = build(["--codex", dest], { CODEX_BIN: codex, CODEX_AUTH_HOME: auth });
    expect(r.stderr).toBe("");
    for (const [, [label, , home, installed]] of Object.entries(rows(r.stdout))) {
      expect(home).toBe(join(dest, label, "home"));
      expect(installed).toBe(join(home, "plugins/cache/local/pstack/9.9"));
      expect(realpathSync(join(home, "auth.json"))).toBe(realpathSync(join(auth, "auth.json")));
      expect(JSON.parse(readFileSync(join(dest, label, ".agents/plugins/marketplace.json"), "utf8")).name).toBe("local");
    }
  });
});
