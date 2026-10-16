import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const stop = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8")).hooks.Stop[0];
const command = stop.hooks[0].command;

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-run-gate-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const bashResult = (text, extra = {}) =>
  JSON.stringify({
    type: "user",
    ...extra,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] },
  });

const arrayResult = (text) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text }] }] },
  });

function runHook(dir, lines, input = {}) {
  const transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, lines.join("\n") + "\n");
  const r = spawnSync("sh", ["-c", command], {
    env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: pluginRoot },
    input: JSON.stringify({ hook_event_name: "Stop", transcript_path: transcript, stop_hook_active: false, ...input }),
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function todo(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

describe("run-gate Stop hook", () => {
  test("stays out of a session that never ran open-run", () =>
    withDir((dir) => {
      expect(runHook(dir, [bashResult("hello")])).toEqual({ status: 0, out: "", err: "" });
    }));

  test("blocks the stop and lists each open step", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [x] 1. done\n- [ ] 2. Run `/deslop` over the diff before commit.\n");
      const r = runHook(dir, [bashResult(`${file}: 2 steps, 3 PR gates\n${dir}/decisions.tsv: started`)]);
      expect(r.status).toBe(2);
      expect(r.err).toContain(`${file}:2: 2. Run \`/deslop\` over the diff before commit.`);
      expect(r.err).toContain("skip: <reason>");
    }));

  test("names the list it blocked on by its own file name", () =>
    withDir((dir) => {
      const plain = todo(dir, "todo.md", "- [ ] 1. open\n");
      expect(runHook(dir, [bashResult(`${plain}: 1 steps`)]).err).toContain(`${basename(dir)}/todo.md still has open steps`);
    }));

  test("blocks on a slug-named list in a shared checkout's .audit", () =>
    withDir((dir) => {
      mkdirSync(join(dir, ".audit"));
      const file = todo(dir, ".audit/fix-login.todo.md", "- [x] 1. done\n- [ ] 2. open\n");
      const r = runHook(dir, [bashResult(`${file}: 2 steps\n${dir}/.audit/fix-login.tsv: started`)]);
      expect(r.status).toBe(2);
      expect(r.err).toContain(".audit/fix-login.todo.md still has open steps.");
      expect(r.err).toContain(`${file}:2: 2. open`);
    }));

  test("stays out of a markdown file that only ends in todo.md", () =>
    withDir((dir) => {
      const file = todo(dir, "mytodo.md", "- [ ] 1. open\n");
      expect(runHook(dir, [bashResult(`${file}: 1 steps`)]).status).toBe(0);
    }));

  test("lets the stop through when every step is done or skipped", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [x] 1. done\n- [ ] 2. PR skip: user said push only when asked\n");
      expect(runHook(dir, [bashResult(`${file}: 2 steps`)]).status).toBe(0);
    }));

  test("recognizes a rerun that left the list in place", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. open\n");
      expect(runHook(dir, [bashResult(`${file} exists; left as is`)]).status).toBe(2);
    }));

  test("finds a list whose path has a space in it", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. open\n");
      const spaced = join(dir, "my run");
      spawnSync("mkdir", [spaced]);
      writeFileSync(join(spaced, "todo.md"), readFileSync(file));
      expect(runHook(dir, [bashResult(`${spaced}/todo.md: 1 steps`)]).status).toBe(2);
    }));

  test("reads tool results given as text blocks", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. open\n");
      expect(runHook(dir, [arrayResult(`${file}: 1 steps`)]).status).toBe(2);
    }));

  test("checks the latest list the session opened", () =>
    withDir((dir) => {
      const first = todo(dir, "first.md", "- [ ] 1. open\n");
      const second = todo(dir, "todo.md", "- [x] 1. done\n");
      expect(runHook(dir, [bashResult(`${first}: 1 steps`), bashResult(`${second}: 1 steps`)]).status).toBe(0);
    }));

  test("ignores a list a subagent opened on a sidechain", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. open\n");
      expect(runHook(dir, [bashResult(`${file}: 1 steps`, { isSidechain: true })]).status).toBe(0);
    }));

  test("lets the second stop through so a blocked stop cannot loop", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. open\n");
      expect(runHook(dir, [bashResult(`${file}: 1 steps`)], { stop_hook_active: true }).status).toBe(0);
    }));

  test("lets the stop through when the list it found is gone", () =>
    withDir((dir) => {
      expect(runHook(dir, [bashResult(`${dir}/missing/todo.md: 1 steps`)]).status).toBe(0);
    }));
});
