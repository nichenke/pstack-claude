import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gate, scoreStream, workTree } from "../evals/run-gate/score.mjs";

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
const init = { type: "system", subtype: "init", cwd: repo, plugins: [{ name: "pstack", path: "/arms/p3/pstack" }] };
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
    expect(s.todoPath).toBe("/scratch/todo.md");
    expect(s.checkRan).toBe(true);
    expect(s.skills).toEqual(["pstack:poteto-mode", "pstack:deslop"]);
    expect(s.gateBlocks).toBe(1);
    expect(s.plugin).toBe("/arms/p3/pstack");
    expect(s.result).toEqual({ ok: true, turns: 9, ms: 1000, usd: 1.5 });
  });

  test("a list opened only after editing does not count as before the first edit", () => {
    const s = scoreStream([init, use("Edit", { file_path: `${repo}/a.py` }), use("TaskCreate", { subject: "x" }), done]);
    expect(s.list).toEqual({ kind: "task-tool", beforeFirstEdit: false });
  });

  test("a hand-written todo.md counts, and writing it is not the first edit", () => {
    const s = scoreStream([init, use("Write", { file_path: "/scratch/todo.md" }), use("Edit", { file_path: `${repo}/a.py` }), done]);
    expect(s.list).toEqual({ kind: "todo.md", beforeFirstEdit: true });
    expect(s.todoPath).toBe("/scratch/todo.md");
  });

  test("a slug-named list counts, opened by open-run or written by hand, and neither file is the first edit", () => {
    const viaScript = scoreStream([
      init,
      use("Bash", { command: "node /arms/p3/pstack/skills/poteto-mode/scripts/open-run.mjs --slug t bug-fix .audit" }),
      result(`${repo}/.audit/t.todo.md: 6 steps, 3 PR gates\n${repo}/.audit/t.tsv: started`),
      done,
    ]);
    expect(viaScript.list.kind).toBe("open-run");
    expect(viaScript.todoPath).toBe(`${repo}/.audit/t.todo.md`);
    const byHand = scoreStream([
      init,
      use("Write", { file_path: `${repo}/.audit/t.todo.md` }),
      use("Write", { file_path: `${repo}/.audit/t.tsv` }),
      use("Edit", { file_path: `${repo}/a.py` }),
      done,
    ]);
    expect(byHand.list).toEqual({ kind: "todo.md", beforeFirstEdit: true });
    expect(byHand.todoPath).toBe(`${repo}/.audit/t.todo.md`);
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
    expect(s.todoPath).toBe(null);
    expect(s.firstEditSeen).toBe(false);
    expect(s.skills).toEqual(["pstack:no-comments"]);
  });

  test("a stop hook that exits 2 for another reason is not a gate block", () => {
    expect(scoreStream([init, stop(2, "lint failed"), done]).gateBlocks).toBe(0);
  });

  test("a run with no result line reports not ok", () => {
    expect(scoreStream([init]).result).toEqual({ ok: false, turns: null, ms: null, usd: null });
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
