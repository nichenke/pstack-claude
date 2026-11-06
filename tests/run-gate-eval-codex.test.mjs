import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childRollouts, scoreCodex } from "../evals/run-gate/score-codex.mjs";

// Shapes copied from codex-cli 0.165.0 `exec --json` output and its rollout file.
const THREAD = "01a1ae09-c8f1-78f3-ba8c-6c7e8651b1e1";
const ROOT = "/work/.plugins/ab12/home/plugins/cache/local/pstack/0.9130.1";
let n = 0;
const started = { type: "thread.started", thread_id: THREAD };
const done = { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 7 } };
const item = (body, type = "item.completed") => ({ type, item: { id: `item_${n++}`, ...body } });
const exec = (command, output = "") =>
  item({ type: "command_execution", command: `/bin/zsh -lc '${command}'`, aggregated_output: output, exit_code: 0, status: "completed" });
const edit = (...paths) => item({ type: "file_change", changes: paths.map((path) => ({ path, kind: "update" })), status: "completed" });
const plan = (type, ...steps) => item({ id: "item_plan", type: "todo_list", items: steps.map(([text, completed]) => ({ text, completed })) }, type);
const warning = item({ type: "error", message: "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation." });
const hookPrompt = (text) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "HookPrompt", fragments: [{ text, hookRunId: "stop:1" }] } } });

describe("scoreCodex", () => {
  test("an open-run list opened before the first edit, with its skills and --check", () => {
    const s = scoreCodex([
      started,
      warning,
      exec(`sed -n 1,200p ${ROOT}/skills/poteto-mode/SKILL.md`),
      exec(`node ${ROOT}/skills/poteto-mode/scripts/open-run.mjs --slug fix bug-fix .audit`, "/work/r/.audit/fix.todo.md: 6 steps, 3 PR gates\n/work/r/.audit/fix.tsv: started\n"),
      edit("/work/r/.audit/fix.todo.md"),
      edit("/work/r/slugkit/__init__.py"),
      exec(`cat ${ROOT}/skills/deslop/SKILL.md`),
      exec(`node ${ROOT}/skills/poteto-mode/scripts/open-run.mjs --check .audit/fix.todo.md`, "0 open\n"),
      done,
    ]);
    expect(s.session).toBe(THREAD);
    expect(s.plugin).toBe(ROOT);
    expect(s.list).toEqual({ kind: "open-run", beforeFirstEdit: true });
    expect(s.opened).toEqual(["/work/r/.audit/fix.todo.md"]);
    expect(s.playbook).toBe("bug-fix");
    expect(s.skills).toEqual(["poteto-mode", "deslop"]);
    expect(s.checkRan).toBe(true);
    expect(s.firstEditSeen).toBe(true);
    expect(s.result).toEqual({ ok: true, turns: null, ms: null, usd: null });
    expect(s.tokens).toEqual(done.usage);
    expect(s.delegatesInFlight).toBe(0);
  });

  test("a brace list of SKILL.md paths reads each skill in it", () => {
    const s = scoreCodex([started, exec(`cat ${ROOT}/skills/{no-comments,deslop}/SKILL.md; cat ${ROOT}/skills/tdd/SKILL.md`), done]);
    expect(s.skills).toEqual(["no-comments", "deslop", "tdd"]);
  });

  test("the native list is the last todo_list state, with a skip reason in a step's text", () => {
    const s = scoreCodex([
      started,
      exec(`node ${ROOT}/skills/poteto-mode/scripts/open-run.mjs --dry-run bug-fix`, "# bug-fix\n\n- [ ] 1. Reproduce\n"),
      plan("item.started", ["1. Reproduce", false], ["Run `/deslop` over the diff before commit.", false]),
      edit("/work/r/a.py"),
      plan("item.updated", ["1. Reproduce", true], ["Run `/deslop` over the diff before commit. skip: one-line diff", true]),
      plan("item.completed", ["1. Reproduce", true], ["Run `/deslop` over the diff before commit. skip: one-line diff", true]),
      done,
    ]);
    expect(s.list).toEqual({ kind: "task-tool", beforeFirstEdit: true });
    expect(s.playbook).toBe("bug-fix");
    expect(s.taskTools).toBe(true);
    expect(s.taskList).toEqual({ total: 2, open: 0, skipped: 1 });
    expect(s.native.map((step) => step.text)).toEqual(["1. Reproduce", "Run `/deslop` over the diff before commit. skip: one-line diff"]);
  });

  test("an edit before any list, and a todo.md written through a patch, count as Claude's do", () => {
    const late = scoreCodex([started, edit("/work/r/a.py"), plan("item.completed", ["x", false]), done]);
    expect(late.list).toEqual({ kind: "task-tool", beforeFirstEdit: false });
    const byHand = scoreCodex([started, edit("/work/r/todo.md"), edit("/work/r/a.py"), done]);
    expect(byHand.list).toEqual({ kind: "todo.md", beforeFirstEdit: true });
    expect(byHand.written).toBe("/work/r/todo.md");
  });

  test("the rollout supplies gate blocks, delegate launches and whether update_plan was offered", () => {
    const rollout = [
      { type: "response_item", payload: { type: "additional_tools", tools: [{ name: "exec", description: "declare const tools: { update_plan(args: {}) }" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", name: "exec", input: "await tools.spawn_agent({task: 'a'}); await tools.spawn_agent ({task: 'b'})" } },
      hookPrompt("poteto-mode: .audit/fix.todo.md still has open steps.\n.audit/fix.todo.md:7: 2. Fix"),
      hookPrompt("some other hook said no"),
    ];
    const s = scoreCodex([started, done], rollout);
    expect(s.gateBlocks).toBe(1);
    expect(s.delegates).toBe(2);
    const direct = { type: "response_item", payload: { type: "function_call", name: "spawn_agent", arguments: "{}" } };
    expect(scoreCodex([started, done], [direct, direct]).delegates).toBe(2);
    expect(s.taskTools).toBe(true);
    expect(scoreCodex([started, done], []).taskTools).toBe(false);
  });

  test("a failed turn or no completed turn is not ok, while an error item the run recovered from is a warning", () => {
    expect(scoreCodex([started, warning, done]).result.ok).toBe(true);
    expect(scoreCodex([started, warning, done]).warnings).toBe(0);
    expect(scoreCodex([started, { type: "turn.failed", error: { message: "x" } }]).result.ok).toBe(false);
    const recovered = scoreCodex([started, item({ type: "error", message: "stream disconnected, reconnecting" }), done]);
    expect([recovered.result.ok, recovered.warnings]).toEqual([true, 1]);
    expect(scoreCodex([started]).result.ok).toBe(false);
  });

  test("token usage is summed over every completed turn", () => {
    const more = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } };
    expect(scoreCodex([started, done, more]).tokens).toEqual({ input_tokens: 110, cached_input_tokens: 50, output_tokens: 10 });
  });

  test("with no rollout found, every field only the rollout can supply is unknown", () => {
    const s = scoreCodex([started, done], null, []);
    expect([s.gateBlocks, s.taskTools, s.delegates, s.delegatesInFlight]).toEqual([null, null, null, null]);
  });
});

describe("Codex delegates", () => {
  const task = (type) => ({ type: "event_msg", payload: { type } });

  const meta = (parent) => ({ type: "session_meta", payload: { id: `c-${parent}`, parent_thread_id: parent } });
  const spawn = { type: "response_item", payload: { type: "function_call", name: "spawn_agent", arguments: "{}" } };

  test("a delegate whose last task event is a start was still in flight when the run ended", () => {
    const abandoned = [meta(THREAD), task("task_started"), task("task_started")];
    const finished = [meta(THREAD), task("task_started"), task("task_complete")];
    const s = scoreCodex([started, done], [spawn, spawn], [abandoned, finished]);
    expect(s.delegatesInFlight).toBe(1);
    expect(s.delegates).toBe(2);
    expect(scoreCodex([started, done]).delegatesInFlight).toBe(0);
  });

  test("more spawns than delegate rollouts found leaves the in-flight count unknown", () => {
    const finished = [meta(THREAD), task("task_started"), task("task_complete")];
    expect(scoreCodex([started, done], [spawn, spawn], [finished]).delegatesInFlight).toBe(null);
    const grandchild = [meta("c-x"), task("task_started")];
    expect(scoreCodex([started, done], [spawn], [finished, grandchild]).delegatesInFlight).toBe(1);
  });

  test("a gate skill or command a delegate ran counts, from its rollout's CommandExecution items", () => {
    const ran = (exit_code, ...command) => ({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command, exit_code, aggregated_output: "" } } });
    const child = [
      meta(THREAD),
      task("task_started"),
      ran(0, "/bin/zsh", "-lc", `cat ${ROOT}/skills/deslop/SKILL.md`),
      ran(1, "/bin/zsh", "-lc", `cat ${ROOT}/skills/no-comments/SKILL.md`),
      ran(1, "/bin/zsh", "-lc", "gh pr create --fill"),
      task("task_complete"),
    ];
    const s = scoreCodex([started, done], [spawn], [child]);
    expect(s.skills).toEqual(["deslop"]);
    expect(s.commands).toContain("/bin/zsh -lc gh pr create --fill");
    expect(s.list.kind).toBe(null);
  });

  test("childRollouts follows parent_thread_id down from the run's thread, and skips other runs' threads", () => {
    const sessions = mkdtempSync(join(tmpdir(), "sessions-"));
    mkdirSync(join(sessions, "2026/11/05"), { recursive: true });
    const rollout = (id, parent, source = { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1 } } }) => {
      const file = join(sessions, "2026/11/05", `rollout-x-${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "session_meta", payload: { id, ...(parent ? { parent_thread_id: parent, source } : {}) } })}\n`);
      return file;
    };
    rollout("main");
    rollout("guardian", "main", { subagent: { other: "guardian" } });
    const child = rollout("child", "main");
    const grandchild = rollout("grandchild", "child");
    rollout("other");
    rollout("other-child", "other");
    expect(childRollouts(sessions, "main").sort()).toEqual([child, grandchild].sort());
    expect(childRollouts(join(sessions, "missing"), "main")).toEqual([]);
  });
});
