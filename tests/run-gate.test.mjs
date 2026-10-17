import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const stop = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8")).hooks.Stop[0];
const command = stop.hooks[0].command;
const openRun = join(pluginRoot, "skills/poteto-mode/scripts/open-run.mjs");
const records = JSON.parse(readFileSync(new URL("fixtures/run-gate/transcript-records.json", import.meta.url), "utf8"));
const SESSION = "s1";

function openRunOut(...args) {
  const env = { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION };
  return spawnSync("node", [openRun, ...args], { encoding: "utf8", env }).stdout;
}

const record = (name, id) => JSON.stringify(records[name]).replace(/[abw]0{15}1/g, id ?? "$&");

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
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: SESSION,
      transcript_path: transcript,
      stop_hook_active: false,
      ...input,
    }),
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function todo(dir, name, body, session = SESSION) {
  const file = join(dir, name);
  writeFileSync(file, `${session ? `Session: ${session}\n` : ""}${body}`);
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
      expect(r.err).toContain(`${file}:3: 2. Run \`/deslop\` over the diff before commit.`);
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
      expect(r.err).toContain(`${file}:3: 2. open`);
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

  test("lets the stop through when the only open box is BLOCKED with a reason", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [x] 1. done\n- [ ] BLOCKED: independent review\n");
      expect(runHook(dir, [bashResult(`${file}: 2 steps`)]).status).toBe(0);
      todo(dir, "todo.md", "- [x] 1. done\n- [ ] BLOCKED:\n");
      expect(runHook(dir, [bashResult(`${file}: 2 steps`)]).status).toBe(2);
    }));

  test("stays silent after a dry run, and a later dry run does not hide a real run's open list", () =>
    withDir((dir) => {
      const preview = openRunOut("--dry-run", "bug-fix", dir);
      expect(preview).toContain("- [ ] ");
      expect(runHook(dir, [bashResult(preview)])).toEqual({ status: 0, out: "", err: "" });
      const real = openRunOut("bug-fix", join(dir, "real"));
      expect(runHook(dir, [bashResult(real), bashResult(openRunOut("--dry-run", "feature"))]).status).toBe(2);
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

describe("run-gate holds only this session's list", () => {
  const open = "- [x] 1. done\n- [ ] 2. open\n";

  test("another session's list, adopted from a shared work dir, holds nothing", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", open, "s2");
      expect(runHook(dir, [bashResult(`${file} exists; left as is`)])).toEqual({ status: 0, out: "", err: "" });
      expect(runHook(dir, [bashResult(`${file}: 2 steps`)]).status).toBe(0);
    }));

  test("a list with no session id holds nothing", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", open, null);
      expect(runHook(dir, [bashResult(`${file}: 2 steps`)]).status).toBe(0);
    }));

  test("a hook input with no session id holds nothing", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", open);
      expect(runHook(dir, [bashResult(`${file}: 2 steps`)], { session_id: undefined }).status).toBe(0);
    }));

  test("looks back past a later list another session owns to this session's open one", () =>
    withDir((dir) => {
      mkdirSync(join(dir, "theirs"));
      const mine = todo(dir, "todo.md", open);
      const theirs = todo(dir, "theirs/todo.md", "- [x] 1. done\n", "s2");
      const r = runHook(dir, [bashResult(`${mine}: 2 steps`), bashResult(`${theirs} exists; left as is`)]);
      expect(r.status).toBe(2);
      expect(r.err).toContain(`${basename(dir)}/todo.md still has open steps`);
    }));

  test("a later list of this session's own still supersedes an earlier one", () =>
    withDir((dir) => {
      mkdirSync(join(dir, "next"));
      const first = todo(dir, "todo.md", open);
      const next = todo(dir, "next/todo.md", "- [x] 1. done\n");
      expect(runHook(dir, [bashResult(`${first}: 2 steps`), bashResult(`${next}: 1 steps`)]).status).toBe(0);
    }));

  test("a later list that is gone does not revive the one it superseded", () =>
    withDir((dir) => {
      const first = todo(dir, "todo.md", open);
      expect(runHook(dir, [bashResult(`${first}: 2 steps`), bashResult(`${dir}/gone/todo.md: 1 steps`)]).status).toBe(0);
    }));

  test("end to end with open-run: the opening session is held, any other is not", () =>
    withDir((dir) => {
      const out = openRunOut("bug-fix", join(dir, "run"));
      expect(runHook(dir, [bashResult(out)]).status).toBe(2);
      expect(runHook(dir, [bashResult(out)], { session_id: "s2" }).status).toBe(0);
    }));
});

describe("run-gate lets a stop through while background work runs", () => {
  const open = "- [x] 1. done\n- [ ] 2. open\n";
  const A = "a1111111111111111";
  const B = "a2222222222222222";
  const gate = (dir, lines, input) => runHook(dir, [bashResult(`${todo(dir, "todo.md", open)}: 2 steps`), ...lines], input).status;

  test("an async agent launched and not finished lets the stop through", () =>
    withDir((dir) => expect(gate(dir, [record("agent-launch", A)])).toBe(0)));

  test("its completion, delivered as a user turn or as an attachment, brings the gate back", () =>
    withDir((dir) => {
      expect(gate(dir, [record("agent-launch", A), record("notification-user", A)])).toBe(2);
      expect(gate(dir, [record("agent-launch", A), record("notification-attachment", A)])).toBe(2);
    }));

  test("two agents in flight hold the gate open until both finish", () =>
    withDir((dir) => {
      const both = [record("agent-launch", A), record("agent-launch", B)];
      expect(gate(dir, [...both, record("notification-user", A)])).toBe(0);
      expect(gate(dir, [...both, record("notification-user", A), record("notification-attachment", B)])).toBe(2);
    }));

  test("duplicate and stray completions never count below zero", () =>
    withDir((dir) => {
      const done = [record("agent-launch", A), record("notification-user", A), record("notification-attachment", A)];
      expect(gate(dir, [...done, record("notification-user", A)])).toBe(2);
      expect(gate(dir, [record("notification-user", B), record("agent-launch", A), record("notification-user", A)])).toBe(2);
      expect(gate(dir, [...done, record("notification-user", B), record("agent-launch", B)])).toBe(0);
    }));

  test("queue-operation records alone neither finish nor launch anything", () =>
    withDir((dir) => {
      expect(gate(dir, [record("agent-launch", A), record("queue-enqueue", A), record("queue-remove", A)])).toBe(0);
      expect(gate(dir, [record("queue-enqueue", A)])).toBe(2);
    }));

  test("an agent resumed with SendMessage is in flight again until it notifies again", () =>
    withDir((dir) => {
      const first = [record("agent-launch", A), record("notification-user", A), record("agent-resume", A)];
      expect(gate(dir, first)).toBe(0);
      expect(gate(dir, [...first, record("notification-attachment", A)])).toBe(2);
    }));

  test("killed, stopped, and TaskStop end an agent; a pending notification does not", () =>
    withDir((dir) => {
      expect(gate(dir, [record("agent-launch", A), record("notification-killed", A)])).toBe(2);
      expect(gate(dir, [record("agent-launch", A), record("notification-stopped", A)])).toBe(2);
      expect(gate(dir, [record("agent-launch", A), record("task-stop", A)])).toBe(2);
      expect(gate(dir, [record("agent-launch", A), record("notification-pending")])).toBe(0);
    }));

  test("an agent that completed while waiting on its own background work stays in flight until it notifies again", () =>
    withDir((dir) => {
      const interim = [record("agent-launch", A), record("notification-interim", A)];
      expect(gate(dir, interim)).toBe(0);
      expect(gate(dir, [...interim, record("notification-attachment", A)])).toBe(2);
      expect(gate(dir, [...interim, record("notification-killed", A)])).toBe(2);
    }));

  test("a final result that quotes the interim wording still ends the agent", () =>
    withDir((dir) => {
      const quoted = record("notification-user", A).replace(
        "</summary>",
        "</summary>\\n<result>it is waiting on its own background work</result>",
      );
      expect(gate(dir, [record("agent-launch", A), quoted])).toBe(2);
    }));

  test("with background_tasks, a waiting agent holds the stop open only while some task is still listed", () =>
    withDir((dir) => {
      const interim = [record("agent-launch", A), record("notification-interim", A)];
      const shell = { background_tasks: [{ id: "b1", type: "shell", status: "running", description: "x" }] };
      expect(gate(dir, interim, shell)).toBe(0);
      expect(gate(dir, interim, { background_tasks: [] })).toBe(2);
      expect(gate(dir, [...interim, record("notification-user", A)], shell)).toBe(2);
      expect(gate(dir, [record("agent-launch", A)], shell)).toBe(2);
    }));

  test("a background forked skill and a workflow count as in flight", () =>
    withDir((dir) => {
      expect(gate(dir, [record("forked-skill-launch", A)])).toBe(0);
      expect(gate(dir, [record("forked-skill-launch", A), record("notification-user", A)])).toBe(2);
      expect(gate(dir, [record("workflow-launch", "w3333333333333333")])).toBe(0);
    }));

  test("a background shell command or a monitor does not, since either can outlive the work", () =>
    withDir((dir) => {
      expect(gate(dir, [record("bash-launch")])).toBe(2);
      expect(gate(dir, [record("monitor-launch")])).toBe(2);
    }));

  test("a launch on a subagent's sidechain is the subagent's, not the main session's", () =>
    withDir((dir) => {
      const sidechain = JSON.stringify({ ...JSON.parse(record("agent-launch", A)), isSidechain: true });
      expect(gate(dir, [sidechain])).toBe(2);
    }));

  test("a transcript with unparsable lines and no launch record blocks as before", () =>
    withDir((dir) => expect(gate(dir, ["{not json", '{"type":"user","toolUseResult":"async_launched"}'])).toBe(2)));

  test("the Stop input's background_tasks, when present, decides instead of the transcript", () =>
    withDir((dir) => {
      const running = (type) => ({ background_tasks: [{ id: A, type, status: "running", description: "x" }] });
      expect(gate(dir, [], running("subagent"))).toBe(0);
      expect(gate(dir, [], running("workflow"))).toBe(0);
      expect(gate(dir, [], running("shell"))).toBe(2);
      expect(gate(dir, [], running("monitor"))).toBe(2);
      expect(gate(dir, [record("agent-launch", A)], { background_tasks: [] })).toBe(2);
      expect(gate(dir, [], { background_tasks: [{ id: A, type: "subagent", status: "completed" }] })).toBe(2);
      expect(gate(dir, [record("agent-launch", A)], { background_tasks: "bogus" })).toBe(0);
    }));

  test("in-flight work never holds a stop the list would let through", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [x] 1. done\n");
      expect(runHook(dir, [bashResult(`${file}: 1 steps`), record("agent-launch", A)]).status).toBe(0);
      expect(runHook(dir, [record("agent-launch", A)], { background_tasks: [] }).status).toBe(0);
    }));

  test("stop_hook_active still lets the second stop through with an agent finished", () =>
    withDir((dir) =>
      expect(gate(dir, [record("agent-launch", A), record("notification-user", A)], { stop_hook_active: true })).toBe(0)));
});

