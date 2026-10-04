#!/usr/bin/env node
// Scores one run directory written by run-one.sh: reads its stream-json output,
// the todolist the run kept, and the final repo, and writes score.json beside them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const openRun = path.resolve(here, "../../plugins/pstack/skills/poteto-mode/scripts/open-run.mjs");
// Same pattern run-gate.mjs reads, so the scorer and the hook agree on which list a run opened.
const OPENED = /^(\/.*?\/todo\.md)(?:: \d+ steps| exists; left as is)/gm;
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const LIST_FILES = /\/(todo\.md|decisions\.tsv)$/;
// A shell redirect into a *todo*.md file; `2>&1` and plain reads don't match.
const TODO_REDIRECT = /(?:^|[^>2&])>{1,2}\s*["']?([^\s"'|;&<>]*todo[^\s"'|;&<>]*\.md)\b/gi;

function resultText(block) {
  if (typeof block.content === "string") return block.content;
  return (block.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

/**
 * Scores the parsed stream-json lines of one `claude -p` run.
 * Main-thread events (parent_tool_use_id null) decide when the list opened and the first edit;
 * skills and shell commands count from any thread, since a subagent can run a gate for the parent.
 */
export function scoreStream(events) {
  let index = 0;
  let list = null;
  let firstEdit = null;
  let todoPath = null;
  let checkRan = false;
  let gateBlocks = 0;
  let plugin = null;
  let result = { ok: false, turns: null, ms: null, usd: null };
  const skills = [];
  const commands = [];
  const todoHints = [];

  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") {
      plugin = (event.plugins ?? []).find((p) => p.name === "pstack")?.path ?? null;
    }
    if (event.type === "system" && event.subtype === "hook_response" && event.hook_event === "Stop") {
      if (event.exit_code === 2 && String(event.output ?? "").includes("still has open steps")) gateBlocks++;
    }
    if (event.type === "result") {
      result = { ok: !event.is_error, turns: event.num_turns, ms: event.duration_ms, usd: event.total_cost_usd };
    }
    const main = event.parent_tool_use_id == null;
    for (const block of event.message?.content ?? []) {
      if (event.type === "user" && block.type === "tool_result" && main) {
        for (const match of resultText(block).matchAll(OPENED)) todoPath = match[1];
      }
      if (event.type !== "assistant" || block.type !== "tool_use") continue;
      index++;
      const input = block.input ?? {};
      if (block.name === "Skill" && input.skill) skills.push(input.skill);
      if (block.name === "Bash" && input.command) commands.push(input.command);
      if (!main) continue;

      const command = block.name === "Bash" ? String(input.command ?? "") : "";
      const file = String(input.file_path ?? "");
      if (/open-run\.mjs\b/.test(command) && /--check\b/.test(command)) checkRan = true;
      let kind = null;
      if (/open-run\.mjs\b/.test(command) && !/--check\b/.test(command)) kind = "open-run";
      else if (block.name === "TaskCreate" || block.name === "TodoWrite") kind = "task-tool";
      else if (block.name === "Write" && file.endsWith("/todo.md")) kind = "todo.md";
      for (const match of command.matchAll(TODO_REDIRECT)) {
        todoHints.push(match[1]);
        kind ??= "todo.md";
      }
      if (kind && !list) list = { kind, at: index };
      if (block.name === "Write" && file.endsWith("/todo.md") && !todoPath) todoPath = file;
      if (EDITS.has(block.name) && !LIST_FILES.test(file) && firstEdit === null) firstEdit = index;
    }
  }

  return {
    list: { kind: list?.kind ?? null, beforeFirstEdit: Boolean(list) && (firstEdit === null || list.at < firstEdit) },
    firstEditSeen: firstEdit !== null,
    todoPath,
    todoHints,
    checkRan,
    gateBlocks,
    skills,
    commands,
    plugin,
    result,
  };
}

// open-run.mjs --check's rule for a resolved line; keep the two in step.
const SKIPPED = /\b(skip|n\/a): *(?!`?<)\S/;

/**
 * Classifies one commit or PR gate: done when the run did it, skipped when its todolist line
 * carries a filled-in reason (checked off or not), claimed when the line is checked off with no
 * reason but the run never did it, else missing.
 */
export function gate(done, todo, line) {
  if (done) return "done";
  const lines = todo.split("\n").filter((l) => line.test(l));
  if (lines.some((l) => SKIPPED.test(l))) return "skipped";
  if (lines.some((l) => /^- \[x\] /i.test(l))) return "claimed";
  return "missing";
}

const NOT_WORK = /^.. (\.worktrees\/|\.claude\/)|__pycache__/;

/**
 * Picks the checkout that holds a run's work: a candidate may commit on a branch in a worktree
 * under the repo rather than on main. Most commits past the root wins, then uncommitted edits,
 * then the main checkout. `commits` counts every commit on any ref past the root.
 */
const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).stdout.trim();

const worktrees = (repo) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

export function workTree(repo) {
  const root = git(repo, "rev-list", "--max-parents=0", "HEAD").split("\n")[0];
  const trees = worktrees(repo)
    .map((tree, order) => {
      const status = git(tree, "status", "--porcelain").split("\n");
      return {
        path: tree,
        ahead: Number(git(tree, "rev-list", "--count", `${root}..HEAD`) || 0),
        dirty: status.some((entry) => entry && !NOT_WORK.test(entry)),
        order,
      };
    })
    .sort((a, b) => b.ahead - a.ahead || Number(b.dirty) - Number(a.dirty) || a.order - b.order);
  return { path: trees[0].path, commits: Number(git(repo, "rev-list", "--count", "--all", `^${root}`) || 0) };
}

function unittest(repo, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "score-"));
  try {
    fs.cpSync(repo, dir, {
      recursive: true,
      filter: (src) => !/\/(\.git|\.worktrees|__pycache__)(\/|$)/.test(src.slice(repo.length)),
    });
    if (extra) fs.copyFileSync(extra, path.join(dir, "test_hidden.py"));
    const args = extra ? ["-m", "unittest", "test_hidden"] : ["-m", "unittest", "discover", "-s", "tests", "-t", "."];
    const run = spawnSync("python3", args, {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    return run.status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function scoreRun(runDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const events = fs
    .readFileSync(path.join(runDir, "out.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const s = scoreStream(events);

  // The candidate's scratchpad is temporary, so the list and trail are copied out on first scoring.
  const kept = path.join(runDir, "todo.md");
  const trail = path.join(runDir, "decisions.tsv");
  // A list written by hand through the shell is found by its last relative or absolute target.
  const found =
    s.todoPath ??
    s.todoHints
      .flatMap((hint) => (path.isAbsolute(hint) ? [hint] : worktrees(meta.repo).map((tree) => path.join(tree, hint))))
      .findLast((file) => fs.existsSync(file));
  if (!fs.existsSync(kept) && found && fs.existsSync(found)) {
    fs.copyFileSync(found, kept);
    const sibling = path.join(path.dirname(found), "decisions.tsv");
    if (fs.existsSync(sibling)) fs.copyFileSync(sibling, trail);
  }
  const todo = fs.existsSync(kept) ? fs.readFileSync(kept, "utf8") : "";
  let openSteps = null;
  if (todo) {
    const check = spawnSync(process.execPath, [openRun, "--check", kept], { encoding: "utf8" });
    openSteps = Number(check.stdout.match(/^(\d+) open$/m)?.[1] ?? NaN);
  }
  const decisionRows = fs.existsSync(trail)
    ? fs.readFileSync(trail, "utf8").split("\n").filter((l) => l.trim()).length - 1
    : 0;
  const tree = workTree(meta.repo);
  const hidden = path.join(here, "tasks", meta.task, "hidden", "test_hidden.py");

  const exit = path.join(runDir, "exit.json");
  const score = {
    ...meta,
    ...(fs.existsSync(exit) ? JSON.parse(fs.readFileSync(exit, "utf8")) : {}),
    pluginOk: s.plugin === meta.plugin,
    list: s.list.kind,
    listBeforeFirstEdit: s.list.beforeFirstEdit,
    todoKept: Boolean(todo),
    openSteps,
    checkRan: s.checkRan,
    gateBlocks: s.gateBlocks,
    decisionRows,
    tree: tree.path,
    commits: tree.commits,
    gates: {
      deslop: gate(s.skills.some((k) => /deslop/.test(k)), todo, /deslop/i),
      noComments: gate(s.skills.some((k) => /no-comments/.test(k)), todo, /no-comments/i),
      pr: gate(s.commands.some((c) => /\bgh pr create\b/.test(c)), todo, /Opening a PR/),
    },
    visibleTests: unittest(tree.path, null),
    hiddenTests: unittest(tree.path, hidden),
    ...s.result,
  };
  fs.writeFileSync(path.join(runDir, "score.json"), JSON.stringify(score, null, 2) + "\n");
  return score;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const dir of process.argv.slice(2)) console.log(JSON.stringify(scoreRun(dir)));
}
