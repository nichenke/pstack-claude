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

  test("without background_tasks, an agent waiting on its own background work no longer counts as in flight", () =>
    withDir((dir) => {
      const interim = [record("agent-launch", A), record("notification-interim", A)];
      expect(gate(dir, interim)).toBe(2);
      expect(gate(dir, [...interim, record("agent-launch", B)])).toBe(0);
      expect(gate(dir, [...interim, record("agent-resume", A)])).toBe(0);
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

describe("run-gate and an agent waiting on its own background work", () => {
  const open = "- [x] 1. done\n- [ ] 2. open\n";
  const A = "a1111111111111111";
  const B = "a2222222222222222";
  const gate = (dir, lines, input) => runHook(dir, [bashResult(`${todo(dir, "todo.md", open)}: 2 steps`), ...lines], input).status;
  const interim = [record("agent-launch", A), record("notification-interim", A)];
  const listed = (...tasks) => ({
    background_tasks: tasks.map(([id, type = "shell", status = "running"]) => ({ id, type, status, description: "x" })),
  });
  const shellLaunch = (id) => record("sidechain-bash-launch", id);
  const asSidechain = (name, id) => JSON.stringify({ ...JSON.parse(record(name, id)), isSidechain: true });

  function sidechain(dir, agent, lines) {
    const subagents = join(dir, "session", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, `agent-${agent}.jsonl`), lines.map((line) => `${line}\n`).join(""));
  }

  test("a live shell the waiting agent launched on its own sidechain lets the stop through", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b9fhaii20")]);
      expect(gate(dir, interim, listed(["b9fhaii20"]))).toBe(0);
      expect(gate(dir, interim, listed(["b1"], ["b9fhaii20"]))).toBe(0);
      sidechain(dir, A, [arrayResult("Command running in background with ID: b9fhaii20. Output is being written to: /x")]);
      expect(gate(dir, interim, listed(["b9fhaii20"]))).toBe(0);
    }));

  test("only a tool result that starts with a launch line counts, so one the agent read in a log or transcript does not", () =>
    withDir((dir) => {
      sidechain(dir, A, [arrayResult("session.jsonl:7: Command running in background with ID: b9fhaii20. Output is being written to: /x")]);
      expect(gate(dir, interim, listed(["b9fhaii20"]))).toBe(2);
      sidechain(dir, A, [arrayResult("Monitor started (task bx86nb4ap, expires in 30m unless the source ends first)")]);
      expect(gate(dir, interim, listed(["bx86nb4ap", "monitor"]))).toBe(0);
    }));

  test("a live shell another agent launched holds the stop, unless that agent is waiting too", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b2")]);
      sidechain(dir, B, [shellLaunch("b1")]);
      const finished = [record("agent-launch", B), record("notification-user", B), ...interim];
      expect(gate(dir, finished, listed(["b1"]))).toBe(2);
      expect(gate(dir, [...interim, record("agent-launch", B), record("notification-interim", B)], listed(["b1"]))).toBe(0);
    }));

  test("a live teammate, MCP task, or main-session shell holds the stop", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b2")]);
      expect(gate(dir, interim, listed(["t1", "teammate"]))).toBe(2);
      expect(gate(dir, interim, listed(["m1", "mcp"]))).toBe(2);
      const mainShell = bashResult("Command running in background with ID: b1. Output is being written to: /x");
      expect(gate(dir, [...interim, mainShell], listed(["b1"]))).toBe(2);
      expect(gate(dir, [...interim, record("bash-launch", "b1")], listed(["b1"]))).toBe(2);
    }));

  test("a waiting agent whose own shell has left background_tasks holds the stop, though it never notified again", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b1")]);
      expect(gate(dir, interim, listed(["b1", "shell", "completed"]))).toBe(2);
      expect(gate(dir, interim, listed(["b1", "shell", "killed"]))).toBe(2);
      expect(gate(dir, interim, { background_tasks: [] })).toBe(2);
    }));

  test("a sidechain that is missing or empty, or a launch in a shape it does not know, holds the stop", () =>
    withDir((dir) => {
      expect(gate(dir, interim, listed(["b1"]))).toBe(2);
      sidechain(dir, B, [shellLaunch("b1")]);
      expect(gate(dir, interim, listed(["b1"]))).toBe(2);
      sidechain(dir, A, []);
      expect(gate(dir, interim, listed(["b1"]))).toBe(2);
      sidechain(dir, A, [
        bashResult("Command running in background as task b1", { isSidechain: true }),
        JSON.stringify({ type: "user", isSidechain: true, toolUseResult: { shellId: "b1" } }),
        "{not json",
      ]);
      expect(gate(dir, interim, listed(["b1"]))).toBe(2);
    }));

  test("structured shell and Monitor launch results on a sidechain count; a plain taskId result does not", () =>
    withDir((dir) => {
      const result = (toolUseResult) => JSON.stringify({ type: "user", isSidechain: true, toolUseResult });
      sidechain(dir, A, [
        asSidechain("bash-launch", "b1"),
        asSidechain("monitor-launch", "b2"),
        result({ success: true, taskId: "b3" }),
        result({ taskId: "b4", persistent: "false" }),
      ]);
      expect(gate(dir, interim, listed(["b1"]))).toBe(0);
      expect(gate(dir, interim, listed(["b2", "monitor"]))).toBe(0);
      expect(gate(dir, interim, listed(["b3"]))).toBe(2);
      expect(gate(dir, interim, listed(["b4"]))).toBe(2);
    }));

  test("the agent stays waiting until it notifies again", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b1")]);
      const shell = listed(["b1"]);
      expect(gate(dir, [...interim, record("notification-attachment", A)], shell)).toBe(2);
      expect(gate(dir, [...interim, record("notification-killed", A)], shell)).toBe(2);
      expect(gate(dir, [...interim, record("task-stop", A)], shell)).toBe(2);
      expect(gate(dir, [...interim, record("notification-interim", A)], shell)).toBe(0);
      expect(gate(dir, [...interim, record("agent-resume", A)], shell)).toBe(2);
      expect(gate(dir, [...interim, record("agent-resume", A), record("notification-user", A)], shell)).toBe(2);
      expect(gate(dir, [record("agent-launch", A)], shell)).toBe(2);
    }));

  test("the waiting wording marks only a launched agent, and only on a completed notice", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b1")]);
      const shell = listed(["b1"]);
      expect(gate(dir, [record("notification-interim", A)], shell)).toBe(2);
      const killedWaiting = record("notification-killed", A).replace(
        "<summary>redacted</summary>",
        '<summary>Agent \\"x\\" is waiting on its own background work</summary>',
      );
      expect(gate(dir, [record("agent-launch", A), killedWaiting], shell)).toBe(2);
    }));

  test("only the notice's first summary is read, trimmed and less one trailing period", () =>
    withDir((dir) => {
      sidechain(dir, A, [shellLaunch("b1")]);
      const shell = listed(["b1"]);
      const launch = record("agent-launch", A);
      const tagged = (summary, result = "") =>
        record("notification-user", A).replace("<summary>redacted</summary>", `<summary>${summary}</summary>${result}`);
      expect(gate(dir, [launch, tagged('Agent \\"x\\" is waiting on its own background work')], shell)).toBe(0);
      expect(gate(dir, [launch, tagged('Agent \\"show <result> tags\\" is waiting on its own background work')], shell)).toBe(0);
      expect(gate(dir, [launch, tagged('Agent \\"x\\" is waiting on its own background work. \\n ')], shell)).toBe(0);
      expect(gate(dir, [launch, tagged('Agent \\"x\\" is waiting on its own background work..')], shell)).toBe(2);
      const waitingTagged = 'Agent \\"fix <Button>\\" is waiting on its own background work';
      expect(gate(dir, [launch, tagged(waitingTagged)], shell)).toBe(0);
      expect(gate(dir, [launch, tagged("finished", "\\n<result>it is waiting on its own background work</result>")], shell)).toBe(2);
      expect(gate(dir, [launch, tagged("finished", `\\n<result><summary>${waitingTagged}</summary></result>`)], shell)).toBe(2);
      expect(
        gate(dir, [launch, tagged('Agent \\"fix <Button>\\" finished', `\\n<result><summary>${waitingTagged}</summary></result>`)], shell),
      ).toBe(2);
      const headless = record("notification-user", A).replace("<summary>redacted</summary>", `\\n<result><summary>${waitingTagged}</summary></result>`);
      expect(gate(dir, [launch, headless], shell)).toBe(2);
    }));
});


describe("run-gate Stop hook on a Codex rollout", () => {
  const THREAD = "01a1ae09-c8f1-78f3-ba8c-6c7e8651b1e1";
  const meta = JSON.stringify({ type: "session_meta", payload: { id: THREAD, originator: "codex_exec" } });
  const exec = (output, thread = THREAD) =>
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: thread,
        item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "node open-run.mjs bug-fix ."], aggregated_output: output, exit_code: 0 },
      },
    });
  const opened = (file) => `${file}: 6 steps, 3 PR gates\n${file.replace("todo.md", "decisions.tsv")}: started\n`;
  const runCodex = (dir, lines, input = {}) => runHook(dir, [meta, ...lines], { session_id: THREAD, turn_id: "t1", ...input });

  test("holds the stop while the thread's own list has an open step", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. Reproduce\n", THREAD);
      const r = runCodex(dir, [exec(opened(file))]);
      expect(r.status).toBe(2);
      expect(r.err).toContain("still has open steps");
      expect(r.err).toContain("1. Reproduce");
    }));

  test("lets the stop through once every line is resolved, and on the second stop", () =>
    withDir((dir) => {
      const done = todo(dir, "todo.md", "- [x] 1. Reproduce\n- [ ] 2. Fix skip: not reproducible\n", THREAD);
      expect(runCodex(dir, [exec(opened(done))]).status).toBe(0);
      const open = todo(dir, "b.todo.md", "- [ ] 1. Reproduce\n", THREAD);
      expect(runCodex(dir, [exec(opened(open))], { stop_hook_active: true }).status).toBe(0);
    }));

  test("holds a list stamped with an inherited Claude Code id beside the thread's own", () =>
    withDir((dir) => {
      const file = join(dir, "todo.md");
      writeFileSync(file, `Session: claude-parent\nSession: ${THREAD}\n- [ ] 1. Reproduce\n`);
      expect(runCodex(dir, [exec(opened(file))]).status).toBe(2);
    }));

  test("passes over a list another thread stamped, and a command another thread ran", () =>
    withDir((dir) => {
      const theirs = todo(dir, "todo.md", "- [ ] 1. Reproduce\n", "someone-else");
      expect(runCodex(dir, [exec(opened(theirs))]).status).toBe(0);
      const mine = todo(dir, "m.todo.md", "- [ ] 1. Reproduce\n", THREAD);
      expect(runCodex(dir, [exec(opened(mine), "another-thread")]).status).toBe(0);
    }));

  test("holds while a delegate runs, since Codex reports no background work to the hook", () =>
    withDir((dir) => {
      const file = todo(dir, "todo.md", "- [ ] 1. Reproduce\n", THREAD);
      const spawn = JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.spawn_agent({task: 'x'})" } });
      expect(runCodex(dir, [exec(opened(file)), spawn]).status).toBe(2);
    }));
});
