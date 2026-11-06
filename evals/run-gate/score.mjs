#!/usr/bin/env node
// Scores one run directory written by run-one.sh: reads its runtime's event stream (and a Codex
// run's rollouts), the todolist the run kept, and the final repo, and writes score.json beside them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { OPENED, ownedList, RESOLVED, RUN_FILE, TODO_FILE, trailBeside } from "../../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";
import { DELEGATE, ENDED, openRunPlaybook, taskCounts, TODO_REDIRECT, WAITING } from "./score-common.mjs";
import { childRollouts, scoreCodex } from "./score-codex.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const openRun = path.resolve(here, "../../plugins/pstack/skills/poteto-mode/scripts/open-run.mjs");
const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Bumped whenever a score.json field changes meaning, so a report can refuse to mix scorers. */
export const SCORER = 3;

function resultText(block) {
  if (typeof block.content === "string") return block.content;
  return (block.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

/**
 * Scores the parsed stream-json lines of one `claude -p` run.
 * Main-thread events (parent_tool_use_id null) decide when the list opened, the first edit, and
 * the native task list (TaskCreate tasks under TaskUpdate, merged with the last TodoWrite); skills and shell commands
 * count from any thread, since a subagent can run a gate for the parent. `delegatesInFlight` counts
 * the background agents and workflows still running when the stream ended: the last
 * `background_tasks_changed` list when the stream has one, else launches with no final notice.
 */
export function scoreStream(events) {
  let index = 0;
  let list = null;
  let firstEdit = null;
  let session = null;
  const opened = [];
  let written = null;
  let checkRan = false;
  let gateBlocks = 0;
  let plugin = null;
  let playbook = null;
  let taskTools = false;
  let todos = null;
  const creates = new Map();
  const tasks = new Map();
  let background = null;
  const launched = new Set();
  let launches = 0;
  let stops = 0;
  let created = 0;
  let result = { ok: false, turns: null, ms: null, usd: null };
  let tokens = null;
  const skills = [];
  const commands = [];
  const todoHints = [];
  const trails = [];

  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") {
      session ??= event.session_id ?? null;
      plugin ??= (event.plugins ?? []).find((p) => p.name === "pstack")?.path ?? null;
      taskTools ||= (event.tools ?? []).some((tool) => tool === "TaskCreate" || tool === "TodoWrite");
    }
    if (event.type === "system" && event.subtype === "hook_response" && event.hook_event === "Stop") {
      const said = [event.output, event.stderr, event.stdout].map((text) => String(text ?? "")).join("\n");
      // Every Stop hook reports as hook_name "Stop" with a random id, so only run-gate's block, by its message, is attributable.
      stops++;
      if (event.exit_code === 2 && said.includes("still has open steps")) gateBlocks++;
    }
    if (event.type === "system" && event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
      background = event.tasks.filter((task) => DELEGATE.test(String(task?.task_type ?? ""))).length;
    }
    if (event.type === "system" && event.subtype === "task_started" && event.is_backgrounded && DELEGATE.test(String(event.task_type ?? ""))) {
      launched.add(event.task_id);
      launches++;
    }
    if (event.type === "system" && event.subtype === "task_notification" && ENDED.has(event.status)) {
      if (!(event.status === "completed" && String(event.summary ?? "").endsWith(WAITING))) launched.delete(event.task_id);
    }
    if (event.type === "result") {
      result = { ok: !event.is_error, turns: event.num_turns, ms: event.duration_ms, usd: event.total_cost_usd };
      tokens = event.usage ?? tokens;
    }
    const main = event.parent_tool_use_id == null;
    for (const block of event.message?.content ?? []) {
      if (event.type === "user" && block.type === "tool_result" && main) {
        for (const match of resultText(block).matchAll(OPENED)) opened.push(match[1]);
        const pending = creates.get(block.tool_use_id);
        if (pending) {
          creates.delete(block.tool_use_id);
          created++;
          tasks.set(resultText(block).match(/Task #(\S+) created/)?.[1] ?? `unnumbered-${created}`, pending);
        }
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
      playbook ??= openRunPlaybook(command);
      let kind = null;
      if (/open-run\.mjs\b/.test(command) && !/--(check|dry-run)\b/.test(command)) kind = "open-run";
      else if (block.name === "TaskCreate" || block.name === "TodoWrite") kind = "task-tool";
      else if (block.name === "Write" && TODO_FILE.test(file)) kind = "todo.md";
      for (const match of command.matchAll(TODO_REDIRECT)) {
        todoHints.push(match[1]);
        kind ??= "todo.md";
      }
      if (kind && !list) list = { kind, at: index };
      // Deferred task tools are missing from init's list, so a run that used one was offered it.
      if (block.name === "TaskCreate" || block.name === "TodoWrite") taskTools = true;
      if (block.name === "TaskCreate") {
        creates.set(block.id, { text: String(input.subject ?? ""), note: String(input.description ?? ""), done: false });
      }
      if (block.name === "TaskUpdate" && input.taskId != null) {
        const id = String(input.taskId);
        const task = tasks.get(id);
        if (input.status === "deleted") tasks.delete(id);
        else if (task) {
          if (input.status) task.done = input.status === "completed";
          if (typeof input.subject === "string") task.text = input.subject;
          if (typeof input.description === "string") task.note = input.description;
        }
      }
      if (block.name === "TodoWrite" && Array.isArray(input.todos)) todos = input.todos;
      if (block.name === "Write" && TODO_FILE.test(file)) written ??= file;
      if ((block.name === "Write" || block.name === "Edit") && /decisions\.tsv$/.test(file)) trails.push(file);
      if (EDITS.has(block.name) && !RUN_FILE.test(file) && firstEdit === null) firstEdit = index;
    }
  }

  const native = [
    ...tasks.values(),
    ...(todos ?? []).map((todo) => ({ text: String(todo?.content ?? ""), note: "", done: todo?.status === "completed" })),
  ];
  return {
    list: { kind: list?.kind ?? null, beforeFirstEdit: Boolean(list) && (firstEdit === null || list.at < firstEdit) },
    firstEditSeen: firstEdit !== null,
    session,
    opened,
    written,
    todoHints,
    checkRan,
    gateBlocks: stops ? gateBlocks : null,
    playbook: playbook && path.basename(playbook, ".md"),
    playbookRef: playbook,
    taskTools,
    taskList: taskCounts(native),
    native: native.length ? native : null,
    delegatesInFlight: background ?? launched.size,
    delegates: launches,
    skills,
    commands,
    trails,
    plugin,
    tokens,
    warnings: 0,
    result,
  };
}

/**
 * The list a scored stream kept: the one open-run opened that carries the run's own session id,
 * by the rule the Stop hook uses, else the first todolist the main thread wrote by hand.
 * `read` returns a list's text, or null when it cannot; the default reads the disk.
 */
export function runList(s, read) {
  return ownedList(s.opened, s.session, read) ?? s.written;
}

/**
 * Classifies one commit or PR gate: done when the run did it, skipped when its todolist line
 * carries a filled-in reason (checked off or not), claimed when the line is checked off with no
 * reason but the run never did it, else missing.
 */
export function gate(done, todo, line) {
  if (done) return "done";
  const lines = todo.split("\n").filter((l) => line.test(l));
  if (lines.some((l) => RESOLVED.test(l))) return "skipped";
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
    if (run.error || run.signal) throw new Error(`python3 ${args.join(" ")} in ${repo}: ${run.error?.message ?? `killed by ${run.signal}`}`);
    return run.status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CHECKBOX = /^- \[[ xX]\] /;
const normalize = (text) =>
  String(text)
    .replace(CHECKBOX, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

export const checkboxes = (todo) => todo.split("\n").filter((line) => CHECKBOX.test(line));

/**
 * Verbatim fidelity: how many of the playbook's steps (open-run's `- [ ]` lines) appear as list
 * items. Past checkbox and step number, with whitespace collapsed, an item keeps a step when it holds
 * each of the step's sentences in order, so a `skip:` reason added before, between or after them
 * still counts, and a reworded or shortened sentence does not.
 */
export function fidelity(steps, items) {
  if (!steps.length) return null;
  const texts = items.map(normalize);
  const keeps = (text, step) => {
    let at = 0;
    for (const sentence of normalize(step).split(/(?<=[.!?])\s+/)) {
      const found = text.indexOf(sentence, at);
      if (found === -1) return false;
      at = found + sentence.length;
    }
    return true;
  };
  return { steps: steps.length, matched: steps.filter((step) => texts.some((text) => keeps(text, step))).length };
}

export function outcome(exit, s, capped = false) {
  // timeout exits 124 on its own signal, and 137 when -k had to follow with SIGKILL; a 137 before the cap is some other kill.
  if (exit === 124 || (exit === 137 && capped)) return "timeout";
  if (exit !== 0 || !s.result.ok) return "error";
  if (s.delegatesInFlight === null) return "unknown";
  if (s.delegatesInFlight > 0) return "delegate-in-flight";
  return "clean";
}

/**
 * The JSON lines of a stream or rollout, or null when the file is missing. A last line cut off
 * mid-write, as a timeout kill leaves it, is dropped; a bad line anywhere else throws.
 */
export function readLines(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim());
  return lines.flatMap((line, i) => {
    try {
      return [JSON.parse(line)];
    } catch (error) {
      if (i === lines.length - 1) return [];
      throw new Error(`${file}:${i + 1}: ${error.message}`);
    }
  });
}

function playbookSteps(plugin, playbook) {
  const isBundled = playbook && !playbook.includes("/") && !playbook.endsWith(".md");
  if (!isBundled) return [];
  const script = path.join(plugin, "skills/poteto-mode/scripts/open-run.mjs");
  if (!fs.existsSync(script)) return [];
  const run = spawnSync(process.execPath, [script, "--dry-run", playbook], { encoding: "utf8" });
  return run.status === 0 ? checkboxes(run.stdout) : [];
}

const TRAIL = /(?:^|[\s"'=(])([^\s"'|;&<>(){}=]*decisions\.tsv)\b/g;

/**
 * The trail of a run with no trail beside its list, as with a native-arm run, which keeps no list
 * file: the last existing decisions.tsv named, shell commands first and then file writes, a
 * relative one tried in each of the repo's worktrees, where a candidate on a branch keeps it.
 */
export function trailFrom(s, repo) {
  const named = [...s.commands.flatMap((command) => [...command.matchAll(TRAIL)].map((m) => m[1])), ...(s.trails ?? [])];
  return (
    named
      .flatMap((file) => (path.isAbsolute(file) ? [file] : worktrees(repo).map((tree) => path.join(tree, file))))
      .findLast((file) => fs.existsSync(file)) ?? null
  );
}

function copyCodexChildren(runDir, meta, events) {
  const dir = path.join(runDir, "children");
  const thread = events.find((e) => e.type === "thread.started")?.thread_id;
  if (thread && meta.codexHome && fs.existsSync(meta.codexHome)) {
    const partial = `${dir}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial);
    for (const file of childRollouts(path.join(meta.codexHome, "sessions"), thread)) fs.copyFileSync(file, path.join(partial, path.basename(file)));
    // A rescore after the home lost sessions must not shrink what an earlier scoring captured.
    const had = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const found = new Set(fs.readdirSync(partial));
    if (had.every((file) => found.has(file))) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(partial, dir);
    } else fs.rmSync(partial, { recursive: true, force: true });
  }
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((file) => readLines(path.join(dir, file))) : [];
}

function scoreRun(runDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const runtime = meta.runtime ?? "claude";
  const events = readLines(path.join(runDir, "out.jsonl")) ?? [];
  const s = runtime === "codex" ? scoreCodex(events, readLines(path.join(runDir, "rollout.jsonl")), copyCodexChildren(runDir, meta, events)) : scoreStream(events);

  // The candidate's scratchpad is temporary, so the list and trail are copied out on first scoring.
  const kept = path.join(runDir, "todo.md");
  const trail = path.join(runDir, "decisions.tsv");
  // A list written by hand through the shell is found by its last relative or absolute target.
  const found =
    runList(s) ??
    s.todoHints
      .flatMap((hint) => (path.isAbsolute(hint) ? [hint] : worktrees(meta.repo).map((tree) => path.join(tree, hint))))
      .findLast((file) => fs.existsSync(file));
  if (!fs.existsSync(kept) && found && fs.existsSync(found)) {
    fs.copyFileSync(found, kept);
    const sibling = trailBeside(found);
    if (fs.existsSync(sibling)) fs.copyFileSync(sibling, trail);
  }
  if (!fs.existsSync(trail)) {
    const loose = trailFrom(s, meta.repo);
    if (loose) fs.copyFileSync(loose, trail);
  }
  const todo = fs.existsSync(kept) ? fs.readFileSync(kept, "utf8") : "";
  let openSteps = null;
  if (todo) {
    const check = spawnSync(process.execPath, [openRun, "--check", kept], { encoding: "utf8" });
    const counted = check.stdout.match(/^(\d+) open$/m);
    if (!counted) throw new Error(`open-run --check ${kept} printed no count: ${check.stdout}${check.stderr}`);
    openSteps = Number(counted[1]);
  }
  const listText = todo || (s.native ?? []).map((item) => `- [${item.done ? "x" : " "}] ${item.text} ${item.note}`.trimEnd()).join("\n");
  const items = todo ? checkboxes(todo) : (s.native ?? []).map((item) => item.text);
  const decisionRows = fs.existsSync(trail)
    ? Math.max(0, fs.readFileSync(trail, "utf8").split("\n").filter((l) => l.trim()).length - 1)
    : 0;
  const tree = workTree(meta.repo);
  const hidden = path.join(here, "tasks", meta.task, "hidden", "test_hidden.py");

  const exitFile = path.join(runDir, "exit.json");
  const exit = fs.existsSync(exitFile) ? JSON.parse(fs.readFileSync(exitFile, "utf8")) : {};
  const score = {
    scorer: SCORER,
    ...meta,
    runtime,
    ...exit,
    outcome: outcome(exit.exit, s, exit.seconds >= meta.capMinutes * 60),
    delegatesInFlight: s.delegatesInFlight,
    delegates: s.delegates,
    pluginOk: s.plugin === meta.plugin,
    list: s.list.kind,
    listBeforeFirstEdit: s.list.beforeFirstEdit,
    todoKept: Boolean(todo),
    openSteps,
    checkRan: s.checkRan,
    gateBlocks: s.gateBlocks,
    gateHeld: meta.arm === "todo-hook" && s.gateBlocks !== null ? s.gateBlocks > 0 : null,
    playbook: s.playbook,
    fidelity: fidelity(playbookSteps(meta.plugin, s.playbookRef), items),
    taskTools: s.taskTools,
    taskList: s.taskList,
    decisionRows,
    tree: tree.path,
    commits: tree.commits,
    gates: {
      deslop: gate(s.skills.some((k) => /deslop/.test(k)), listText, /deslop/i),
      noComments: gate(s.skills.some((k) => /no-comments/.test(k)), listText, /no-comments/i),
      pr: gate(s.commands.some((c) => /\bgh pr create\b/.test(c)), listText, /Opening a PR/),
    },
    visibleTests: unittest(tree.path, null),
    hiddenTests: unittest(tree.path, hidden),
    tokens: s.tokens,
    warnings: s.warnings,
    ...s.result,
  };
  fs.writeFileSync(path.join(runDir, "score.json"), JSON.stringify(score, null, 2) + "\n");
  return score;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const dir of process.argv.slice(2)) console.log(JSON.stringify(scoreRun(dir)));
}
