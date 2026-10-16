import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const strip = join(import.meta.dir, "../evals/run-gate/strip-run-gate.sh");
const SENTENCE = " On Claude Code the plugin's Stop hook runs the same check and holds the first stop while a line is open.";
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
