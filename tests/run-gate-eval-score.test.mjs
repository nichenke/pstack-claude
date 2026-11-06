import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fidelity, gate, outcome, runList, scoreStream, trailFrom, workTree } from "../evals/run-gate/score.mjs";

const repo = "/work/slugkit-x1";
let id = 0;

const use = (name, input, parent = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id: `t${++id}`, name, input }] },
});
const result = (text, parent = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: `t${id}`, content: [{ type: "text", text }] }] },
});
const stop = (code, output) => ({ type: "system", subtype: "hook_response", hook_event: "Stop", exit_code: code, output });
const init = { type: "system", subtype: "init", session_id: "s1", cwd: repo, plugins: [{ name: "pstack", path: "/arms/p3/pstack" }] };
const marked = (lists) => (file) => (file in lists ? `Session: ${lists[file]}\n` : null);
const done = { type: "result", subtype: "success", is_error: false, num_turns: 9, duration_ms: 1000, total_cost_usd: 1.5 };

describe("scoreStream", () => {
  test("an open-run list opened before the first edit, with its gates", () => {
    const s = scoreStream([
      init,
      use("Skill", { skill: "pstack:poteto-mode" }),
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs bug-fix /scratch" }),
      result("/scratch/todo.md: 6 steps, 3 PR gates\n/scratch/decisions.tsv: started"),
      use("Edit", { file_path: `${repo}/slugkit/__init__.py` }),
      use("Skill", { skill: "pstack:deslop" }),
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs --check /scratch/todo.md" }),
      stop(2, "poteto-mode: scratch/todo.md still has open steps."),
      stop(0, ""),
      done,
    ]);
    expect(s.list).toEqual({ kind: "open-run", beforeFirstEdit: true });
    expect(s.opened).toEqual(["/scratch/todo.md"]);
    expect(runList(s, marked({ "/scratch/todo.md": "s1" }))).toBe("/scratch/todo.md");
    expect(s.checkRan).toBe(true);
    expect(s.skills).toEqual(["pstack:poteto-mode", "pstack:deslop"]);
    expect(s.gateBlocks).toBe(1);
    expect(s.plugin).toBe("/arms/p3/pstack");
    expect(s.result).toEqual({ ok: true, turns: 9, ms: 1000, usd: 1.5 });
  });

  test("an open-run dry run opens no list", () => {
    const s = scoreStream([
      init,
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs --dry-run bug-fix" }),
      result("# bug-fix\n\n- [ ] 1. Reproduce\n\ndry run, nothing written: 1 steps, 3 PR gates"),
      done,
    ]);
    expect(s.list.kind).toBe(null);
    expect(runList(s, marked({}))).toBe(null);
  });

  test("a list opened only after editing does not count as before the first edit", () => {
    const s = scoreStream([init, use("Edit", { file_path: `${repo}/a.py` }), use("TaskCreate", { subject: "x" }), done]);
    expect(s.list).toEqual({ kind: "task-tool", beforeFirstEdit: false });
  });

  test("a hand-written todo.md counts, and writing it is not the first edit", () => {
    const s = scoreStream([init, use("Write", { file_path: "/scratch/todo.md" }), use("Edit", { file_path: `${repo}/a.py` }), done]);
    expect(s.list).toEqual({ kind: "todo.md", beforeFirstEdit: true });
    expect(runList(s, marked({}))).toBe("/scratch/todo.md");
  });

  test("a slug-named list counts, opened by open-run or written by hand, and neither file is the first edit", () => {
    const viaScript = scoreStream([
      init,
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs --slug t bug-fix .audit" }),
      result(`${repo}/.audit/t.todo.md: 6 steps, 3 PR gates\n${repo}/.audit/t.tsv: started`),
      done,
    ]);
    expect(viaScript.list.kind).toBe("open-run");
    expect(runList(viaScript, marked({ [`${repo}/.audit/t.todo.md`]: "s1" }))).toBe(`${repo}/.audit/t.todo.md`);
    const byHand = scoreStream([
      init,
      use("Write", { file_path: `${repo}/.audit/t.todo.md` }),
      use("Write", { file_path: `${repo}/.audit/t.tsv` }),
      use("Edit", { file_path: `${repo}/a.py` }),
      done,
    ]);
    expect(byHand.list).toEqual({ kind: "todo.md", beforeFirstEdit: true });
    expect(runList(byHand, marked({}))).toBe(`${repo}/.audit/t.todo.md`);
  });

  test("a list adopted from another session is not the run's, by the rule the Stop hook uses", () => {
    const adopt = [
      init,
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs bug-fix /shared" }),
      result("/shared/todo.md exists; left as is\n/shared/decisions.tsv exists; left as is"),
    ];
    expect(runList(scoreStream([...adopt, done]), marked({ "/shared/todo.md": "s2" }))).toBe(null);
    expect(runList(scoreStream([...adopt, done]), marked({ "/shared/todo.md": "s1" }))).toBe("/shared/todo.md");
    const ownAfter = scoreStream([
      ...adopt,
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs bug-fix /mine" }),
      result("/mine/todo.md: 6 steps, 3 PR gates"),
      use("Write", { file_path: "/scratch/todo.md" }),
      done,
    ]);
    expect(runList(ownAfter, marked({ "/shared/todo.md": "s2", "/mine/todo.md": "s1" }))).toBe("/mine/todo.md");
    expect(runList(ownAfter, marked({ "/shared/todo.md": "s2", "/mine/todo.md": "s2" }))).toBe("/scratch/todo.md");
    expect(runList({ ...ownAfter, session: null }, marked({ "/mine/todo.md": "s1" }))).toBe("/scratch/todo.md");
  });

  test("a todo file written through a shell redirect counts as a hand-written list", () => {
    const s = scoreStream([
      init,
      use("Bash", { command: "cd .worktrees/fix && cat > todo.md <<'EOF'\n- [ ] 1. Reproduce\nEOF" }),
      use("Edit", { file_path: `${repo}/a.py` }),
      use("Bash", { command: 'cat > "$TMPDIR/tally-json-todo.md" <<EOF\nx\nEOF' }),
      done,
    ]);
    expect(s.list).toEqual({ kind: "todo.md", beforeFirstEdit: true });
    expect(s.todoHints).toEqual(["todo.md", "$TMPDIR/tally-json-todo.md"]);
  });

  test("reading a todo file through the shell does not open a list", () => {
    const s = scoreStream([init, use("Bash", { command: "cat todo.md; ls todo.md 2>&1" }), done]);
    expect(s.list.kind).toBe(null);
  });

  test("a subagent's tool calls neither open the list nor edit first, but its skills count", () => {
    const s = scoreStream([
      init,
      use("Agent", { prompt: "go" }),
      use("Bash", { command: "node open-run.mjs feature /sub" }, "t1"),
      result("/sub/todo.md: 8 steps", "t1"),
      use("Edit", { file_path: `${repo}/a.py` }, "t1"),
      use("Skill", { skill: "pstack:no-comments" }, "t1"),
      done,
    ]);
    expect(s.list).toEqual({ kind: null, beforeFirstEdit: false });
    expect(s.opened).toEqual([]);
    expect(runList(s, marked({ "/sub/todo.md": "s1" }))).toBe(null);
    expect(s.firstEditSeen).toBe(false);
    expect(s.skills).toEqual(["pstack:no-comments"]);
  });

  test("a stop hook that exits 2 for another reason is not a gate block", () => {
    expect(scoreStream([init, stop(2, "lint failed"), done]).gateBlocks).toBe(0);
  });

  test("a gate block reported only on the hook's stderr still counts", () => {
    const blocked = { ...stop(2, ""), stderr: "poteto-mode: scratch/todo.md still has open steps.\n" };
    expect(scoreStream([init, blocked, done]).gateBlocks).toBe(1);
  });

  test("a native task list counts each created task open until an update completes it", () => {
    const s = scoreStream([
      { ...init, tools: ["Bash", "TaskCreate", "TaskUpdate"] },
      use("TaskCreate", { subject: "1. Reproduce" }),
      result("Task #1 created successfully: 1. Reproduce"),
      use("TaskCreate", { subject: "2. Fix" }),
      result("Task #2 created successfully: 2. Fix"),
      use("TaskCreate", { subject: "3. Drop me" }),
      result("Task #3 created successfully: 3. Drop me"),
      use("TaskUpdate", { taskId: "1", status: "completed" }),
      use("TaskUpdate", { taskId: "2", status: "in_progress" }),
      use("TaskUpdate", { taskId: "3", status: "deleted" }),
      use("TaskUpdate", { taskId: "9", status: "completed" }),
      done,
    ]);
    expect(s.taskTools).toBe(true);
    expect(s.list.kind).toBe("task-tool");
    expect(s.taskList).toEqual({ total: 2, open: 1, skipped: 0 });
  });

  test("the last TodoWrite is the task list, and an empty one is no list", () => {
    const todo = (...statuses) => use("TodoWrite", { todos: statuses.map((status, i) => ({ content: `${i}`, status })) });
    expect(scoreStream([init, todo("pending", "pending"), todo("completed", "in_progress"), done]).taskList).toEqual({ total: 2, open: 1, skipped: 0 });
    expect(scoreStream([init, todo("pending"), todo("completed"), done]).taskList).toEqual({ total: 1, open: 0, skipped: 0 });
    expect(scoreStream([init, todo(), done]).taskList).toBe(null);
  });

  test("a subagent's task list is not the run's, and a session without task tools says so", () => {
    const s = scoreStream([
      init,
      use("Agent", { prompt: "go" }),
      use("TaskCreate", { subject: "sub" }, "t1"),
      result("Task #1 created successfully: sub", "t1"),
      use("TodoWrite", { todos: [{ content: "sub", status: "pending" }] }, "t1"),
      done,
    ]);
    expect(s.taskList).toBe(null);
    expect(s.taskTools).toBe(false);
  });

  test("the playbook comes from the open-run call that opened the list", () => {
    const opened = (command) =>
      scoreStream([init, use("Bash", { command: `node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs ${command}` }), done]).playbook;
    expect(opened("feature /scratch")).toBe("feature");
    expect(opened("--dry-run bug-fix; echo ---")).toBe("bug-fix");
    expect(opened("--slug logs figure-it-out .audit")).toBe("figure-it-out");
    expect(opened("'.agents/playbooks/ship-it.md' /scratch")).toBe("ship-it");
    expect(scoreStream([init, use("Write", { file_path: "/scratch/todo.md" }), done]).playbook).toBe(null);
  });

  test("a native task keeps its subject and description, and a completed task with a skip reason counts as skipped", () => {
    const s = scoreStream([
      init,
      use("TaskCreate", { subject: "1. Reproduce", description: "" }),
      result("Task #1 created successfully: 1. Reproduce"),
      use("TaskCreate", { subject: "Run `/deslop` over the diff before commit.", description: "" }),
      result("Task #2 created successfully: deslop"),
      use("TaskUpdate", { taskId: "1", status: "completed", subject: "1. Reproduce the bug" }),
      use("TaskUpdate", { taskId: "2", status: "completed", description: "skip: the diff is one line" }),
      done,
    ]);
    expect(s.taskList).toEqual({ total: 2, open: 0, skipped: 1 });
    expect(s.native).toEqual([
      { text: "1. Reproduce the bug", note: "", done: true },
      { text: "Run `/deslop` over the diff before commit.", note: "skip: the diff is one line", done: true },
    ]);
    expect(s.taskTools).toBe(true);
  });

  test("the native arm's dry run names the playbook but opens no list", () => {
    const s = scoreStream([init, use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs --dry-run bug-fix" }), done]);
    expect(s.playbook).toBe("bug-fix");
    expect(s.list.kind).toBe(null);
  });

  describe("delegates in flight at the end of the stream", () => {
    const changed = (...types) => ({ type: "system", subtype: "background_tasks_changed", tasks: types.map((t, i) => ({ task_id: `b${i}`, task_type: t })) });
    const started = (id, type = "local_agent") => ({ type: "system", subtype: "task_started", task_id: id, task_type: type, is_backgrounded: true });
    const notice = (id, status, summary = "done") => ({ type: "system", subtype: "task_notification", task_id: id, status, summary });

    test("come from the last background_tasks_changed list, agents and workflows only", () => {
      expect(scoreStream([init, changed("local_agent"), changed("local_agent", "local_bash"), done]).delegatesInFlight).toBe(1);
      expect(scoreStream([init, changed("local_agent"), changed(), done]).delegatesInFlight).toBe(0);
      expect(scoreStream([init, changed("local_bash", "monitor"), done]).delegatesInFlight).toBe(0);
    });

    test("fall back to launches with no final notice", () => {
      const two = scoreStream([init, started("a1"), started("a2"), notice("a1", "completed"), done]);
      expect(two.delegatesInFlight).toBe(1);
      expect(two.delegates).toBe(2);
      expect(scoreStream([init, started("a1"), notice("a1", "killed"), done]).delegatesInFlight).toBe(0);
      expect(scoreStream([init, started("s1", "local_bash"), done]).delegatesInFlight).toBe(0);
    });

    test("count an agent still waiting on its own background work as in flight, as fork PR #2's run-gate does", () => {
      const waiting = notice("a1", "completed", "Agent \"build\" is waiting on its own background work");
      expect(scoreStream([init, started("a1"), waiting, done]).delegatesInFlight).toBe(1);
      expect(scoreStream([init, started("a1"), waiting, notice("a1", "completed"), done]).delegatesInFlight).toBe(0);
    });
  });

  test("a run with no result line reports not ok", () => {
    expect(scoreStream([init]).result).toEqual({ ok: false, turns: null, ms: null, usd: null });
  });
});

describe("fidelity", () => {
  const steps = ["- [ ] 1. Reproduce the bug with a failing test.", "- [ ] 2. Fix the root cause.", "- [ ] Run `/deslop` over the diff before commit."];

  test("counts each step some item starts with, past checkbox, number and spacing", () => {
    const items = ["- [x] 1.  Reproduce the bug with a failing test.", "Fix the root cause. skip: not reproducible", "Run deslop"];
    expect(fidelity(steps, items)).toEqual({ steps: 3, matched: 2 });
  });

  test("a reason inserted between a step's sentences still keeps it", () => {
    const step = "- [ ] 3. Plan the fix. If it crosses a function boundary, `architect` first.";
    const item = "- [x] 3. Plan the fix. skip: delegation, per the user's rule. If it crosses a function boundary, `architect` first.";
    expect(fidelity([step], [item])).toEqual({ steps: 1, matched: 1 });
    expect(fidelity([step], ["- [x] 3. If it crosses a function boundary, `architect` first. Plan the fix."])).toEqual({ steps: 1, matched: 0 });
  });

  test("a shortened or reworded item does not match, and no steps means no score", () => {
    expect(fidelity(steps, ["Reproduce", "Fix root cause"])).toEqual({ steps: 3, matched: 0 });
    expect(fidelity([], ["anything"])).toBe(null);
  });
});

describe("outcome", () => {
  const ok = { result: { ok: true }, delegatesInFlight: 0 };
  test("a timeout and a non-zero exit are not clean, even with a successful result line", () => {
    expect(outcome(124, ok)).toBe("timeout");
    expect(outcome(1, ok)).toBe("error");
    expect(outcome(undefined, ok)).toBe("error");
  });
  test("a failed result is an error, a live delegate is its own outcome, and the rest are clean", () => {
    expect(outcome(0, { ...ok, result: { ok: false } })).toBe("error");
    expect(outcome(0, { ...ok, delegatesInFlight: 2 })).toBe("delegate-in-flight");
    expect(outcome(0, { ...ok, delegatesInFlight: null })).toBe("unknown");
    expect(outcome(0, ok)).toBe("clean");
  });
});

describe("gate", () => {
  const todo = [
    "- [ ] Run `/deslop` over the diff before commit. skip: no diff left",
    "- [ ] Run `/no-comments` before review. skip:",
    "- [ ] Run **Opening a PR**, or keep this line with `skip: <the user or harness rule that blocks it>`.",
  ].join("\n");

  test("done wins over anything the list says", () => expect(gate(true, todo, /deslop/i)).toBe("done"));
  test("a skip with a reason counts as skipped", () => expect(gate(false, todo, /deslop/i)).toBe("skipped"));
  test("an empty skip reason is missing", () => expect(gate(false, todo, /no-comments/i)).toBe("missing"));
  test("open-run's unedited PR line, whose reason is a placeholder, is missing", () =>
    expect(gate(false, todo, /Opening a PR/)).toBe("missing"));
  test("a BLOCKED line with a reason counts as skipped, a bare one as missing", () => {
    expect(gate(false, "- [ ] Run **Opening a PR**. BLOCKED: independent review", /Opening a PR/)).toBe("skipped");
    expect(gate(false, "- [ ] Run **Opening a PR**. BLOCKED:", /Opening a PR/)).toBe("missing");
  });
  test("a checked-off line that carries a reason is still a skip", () =>
    expect(gate(false, "- [x] /no-comments: skip: diff adds no comments.", /no-comments/i)).toBe("skipped"));
  test("a gate checked off that the run never did is claimed", () =>
    expect(gate(false, "- [x] Run `/deslop` over the diff before commit.", /deslop/i)).toBe("claimed"));
  test("no list and nothing done is missing", () => expect(gate(false, "", /deslop/i)).toBe("missing"));
});

describe("workTree", () => {
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const fresh = () => {
    const repo = mkdtempSync(join(tmpdir(), "score-tree-"));
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.py"), "x = 1\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    return repo;
  };
  const commit = (cwd, text) => {
    writeFileSync(join(cwd, "a.py"), text);
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "work");
  };

  test("an untouched repo is scored at its own root with no commits", () => {
    const repo = fresh();
    expect(workTree(repo)).toEqual({ path: realpathSync(repo), commits: 0 });
  });

  test("work committed in a worktree under the repo is scored there", () => {
    const repo = fresh();
    const tree = join(repo, ".worktrees", "fix");
    git(repo, "worktree", "add", "-q", tree, "-b", "fix/x");
    commit(tree, "x = 2\n");
    commit(tree, "x = 3\n");
    expect(workTree(repo)).toEqual({ path: realpathSync(tree), commits: 2 });
  });

  test("uncommitted edits on main beat an idle worktree", () => {
    const repo = fresh();
    git(repo, "worktree", "add", "-q", join(repo, ".worktrees", "idle"), "-b", "idle");
    writeFileSync(join(repo, "a.py"), "x = 9\n");
    expect(workTree(repo)).toEqual({ path: realpathSync(repo), commits: 0 });
  });
});

describe("trailFrom", () => {
  test("finds the last trail a command or write names, a relative one in a worktree under the repo", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "trail-")));
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root");
    git("worktree", "add", "-q", ".worktrees/fix", "-b", "fix");
    mkdirSync(join(dir, ".worktrees/fix/.audit"));
    writeFileSync(join(dir, ".worktrees/fix/.audit/decisions.tsv"), "h\n");
    const abs = join(dir, "abs-decisions.tsv");
    writeFileSync(abs, "h\n");
    const s = (commands, trails = []) => ({ commands, trails });
    expect(trailFrom(s(["D=.audit/decisions.tsv && printf x >>$D"]), dir)).toBe(join(dir, ".worktrees/fix/.audit/decisions.tsv"));
    expect(trailFrom(s([`cp template.tsv '${abs}'`]), dir)).toBe(abs);
    expect(trailFrom(s([], [abs]), dir)).toBe(abs);
    expect(trailFrom(s(["cat /nowhere/decisions.tsv"]), dir)).toBe(null);
  });
});
