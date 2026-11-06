// Scores one `codex exec --json` run into the shape scoreStream returns for a Claude Code run.
import fs from "node:fs";
import path from "node:path";
import { OPENED, RUN_FILE, TODO_FILE } from "../../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";
import { openRunPlaybook, taskCounts, TODO_REDIRECT } from "./score-common.mjs";

const SKILL_READ = /\/skills\/(?:([a-z0-9-]+)|\{([a-z0-9-]+(?:,[a-z0-9-]+)*)\})\/SKILL\.md\b/g;
const PLUGIN_ROOT = /(\/[^\s'"]*?)\/skills\/poteto-mode\//;
// codex exec reports its own --dangerously-bypass-hook-trust warning as an error item.
const HOOK_TRUST_WARNING = "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.";
// A skill counts as read when the command named its SKILL.md and printed its frontmatter name line.
const skillReads = (command, output) =>
  [...command.matchAll(SKILL_READ)]
    .flatMap(([, name, names]) => (name ? [name] : names.split(",")))
    .filter((name) => new RegExp(`^\\s*(?:\\d+\\s+)?name: ${name}\\r?$`, "m").test(output));

/**
 * `events` are the exec stream's lines, which carry only the main thread's items: a list opened, an
 * edit or a skill read by a delegate does not reach them. `rollout` is the thread's rollout file, or
 * null when none was found, which leaves every rollout-only field null;
 * it alone records each Stop hook block (a HookPrompt item), whether `update_plan` was offered (code
 * mode declares it inside the `exec` tool), and each direct `spawn_agent` function call.
 * `children` are the rollouts of the delegates it spawned, each a list of parsed lines. Their
 * CommandExecution items add skills and commands, as a Claude delegate's do, but never a list or an
 * edit. One whose last task event is a start was still running when the run ended (README
 * § Delegates). `delegates` is the most of the direct `spawn_agent` calls, the spawned rollouts found,
 * and one for any code-mode `spawn_agent(`, whose JavaScript the scorer cannot count. `delegatesInFlight`
 * is null when the calls outnumber the rollouts, or code mode spawned and no rollout was found.
 * A skill counts as run when a command printed its SKILL.md, since Codex has no skill tool.
 */
export function scoreCodex(events, rollout = [], children = []) {
  let index = 0;
  let list = null;
  let firstEdit = null;
  let session = null;
  const opened = [];
  let written = null;
  let checkRan = false;
  let playbook = null;
  let plugin = null;
  let todos = null;
  let completed = false;
  let failed = false;
  let tokens = null;
  let warnings = 0;
  const skills = [];
  const commands = [];
  const todoHints = [];
  const trails = [];

  for (const event of events) {
    if (event.type === "thread.started") session ??= event.thread_id ?? null;
    if (event.type === "turn.completed") {
      completed = true;
      // Each turn.completed carries the session's cumulative usage, so the last one is the total.
      tokens = event.usage ?? tokens;
    }
    if (event.type === "turn.failed" || event.type === "error") failed = true;
    const item = event.item;
    if (!item) continue;
    index++;
    // A plan arrives as item.started when it is made and completes only when the turn ends.
    if (item.type === "todo_list" && Array.isArray(item.items)) {
      todos = item.items;
      list ??= { kind: "task-tool", at: index };
    }
    if (item.type === "error" && event.type === "item.completed" && item.message !== HOOK_TRUST_WARNING) warnings++;
    if (event.type !== "item.completed") continue;

    let kind = null;
    if (item.type === "command_execution") {
      const command = String(item.command ?? "");
      commands.push(command);
      skills.push(...skillReads(command, String(item.aggregated_output ?? "")));
      plugin ??= command.match(PLUGIN_ROOT)?.[1] ?? null;
      for (const match of String(item.aggregated_output ?? "").matchAll(OPENED)) opened.push(match[1]);
      if (/open-run\.mjs\b/.test(command) && /--check\b/.test(command)) checkRan = true;
      playbook ??= openRunPlaybook(command);
      if (/open-run\.mjs\b/.test(command) && !/--(check|dry-run)\b/.test(command)) kind = "open-run";
      for (const match of command.matchAll(TODO_REDIRECT)) {
        todoHints.push(match[1]);
        kind ??= "todo.md";
      }
    }
    if (item.type === "file_change") {
      const files = (item.changes ?? []).map((change) => String(change?.path ?? ""));
      trails.push(...files.filter((file) => /decisions\.tsv$/.test(file)));
      const todo = files.find((file) => TODO_FILE.test(file));
      if (todo) {
        kind ??= "todo.md";
        written ??= todo;
      }
      if (firstEdit === null && files.some((file) => file && !RUN_FILE.test(file))) firstEdit = index;
    }
    if (kind && !list) list = { kind, at: index };
  }

  for (const child of children)
    for (const entry of child) {
      const ran = entry?.type === "event_msg" && entry.payload?.type === "item_completed" ? entry.payload.item : null;
      if (ran?.type !== "CommandExecution") continue;
      const command = Array.isArray(ran.command) ? ran.command.join(" ") : String(ran.command ?? "");
      commands.push(command);
      skills.push(...skillReads(command, String(ran.aggregated_output ?? "")));
    }

  let gateBlocks = 0;
  let spawns = 0;
  let codeSites = 0;
  let codeBound = 0;
  let taskTools = false;
  for (const entry of rollout ?? []) {
    const payload = entry?.payload;
    if (entry?.type === "event_msg" && payload?.type === "item_completed" && payload.item?.type === "HookPrompt") {
      if ((payload.item.fragments ?? []).some((part) => String(part?.text).includes("still has open steps"))) gateBlocks++;
    }
    if (entry?.type === "response_item" && payload?.type === "function_call" && payload.name === "spawn_agent") spawns++;
    if (entry?.type === "response_item" && payload?.type === "custom_tool_call") {
      const sites = spawnCalls(String(payload.input ?? ""));
      codeSites += sites.count;
      codeBound += sites.count * (sites.repeated ? 2 : 1);
    }
    if (entry?.type === "response_item" && payload?.type === "additional_tools" && /\bupdate_plan\(/.test(JSON.stringify(payload.tools))) {
      taskTools = true;
    }
  }

  const native = (todos ?? []).map((todo) => ({ text: String(todo?.text ?? ""), note: "", done: todo?.completed === true }));
  const direct = children.filter((child) => parent(child) === session).length;
  return {
    list: { kind: list?.kind ?? null, beforeFirstEdit: Boolean(list) && (firstEdit === null || list.at < firstEdit) },
    firstEditSeen: firstEdit !== null,
    session,
    opened,
    written,
    todoHints,
    checkRan,
    gateBlocks: rollout ? gateBlocks : null,
    playbook: playbook && path.basename(playbook, ".md"),
    playbookRef: playbook,
    taskTools: rollout ? taskTools || todos !== null : null,
    taskList: taskCounts(native),
    native: native.length ? native : null,
    delegatesInFlight: !rollout || spawns + codeBound > direct ? null : children.filter(running).length,
    delegates: rollout ? Math.max(spawns + codeSites, direct) : null,
    warnings,
    skills,
    commands,
    trails,
    plugin,
    tokens,
    result: { ok: completed && !failed, turns: null, ms: null, usd: null },
  };
}

const REPEATING = /(?<![\w$.])(?:for|while)\s*\(|\.\s*(?:map|forEach|flatMap)\s*\(|\bArray\s*\.\s*from\s*\(/;

/** `code` with the body of every string, template text and comment blanked, so a pattern matches only executable text. */
function blankLiterals(code) {
  let out = "";
  const modes = [{ kind: "code", depth: 0 }];
  for (let i = 0; i < code.length; i++) {
    const mode = modes.at(-1);
    const c = code[i];
    if (mode.kind === "code") {
      if (c === "'" || c === '"') modes.push({ kind: "quote", quote: c });
      else if (c === "`") modes.push({ kind: "template" });
      else if (c === "/" && code[i + 1] === "/") modes.push({ kind: "line" });
      else if (c === "/" && code[i + 1] === "*") modes.push({ kind: "block" });
      else if (c === "{") mode.depth++;
      else if (c === "}" && mode.depth === 0 && modes.length > 1) {
        modes.pop();
        out += " ";
        continue;
      } else if (c === "}") mode.depth--;
      out += mode.kind === "code" && modes.at(-1) === mode ? c : " ";
      continue;
    }
    if (mode.kind === "quote") {
      if (c === "\\") i++;
      else if (c === mode.quote) modes.pop();
    } else if (mode.kind === "template") {
      if (c === "\\") i++;
      else if (c === "`") modes.pop();
      else if (c === "$" && code[i + 1] === "{") {
        modes.push({ kind: "code", depth: 0 });
        i++;
      }
    } else if (mode.kind === "line") {
      if (c === "\n") modes.pop();
    } else if (c === "*" && code[i + 1] === "/") {
      modes.pop();
      i++;
    }
    out += c === "\n" ? "\n" : " ";
  }
  return out;
}

/** The `spawn_agent(` call expressions in code-mode source, and whether a loop or iterator could run one more than once. */
function spawnCalls(code) {
  const live = blankLiterals(code);
  const count = live.match(/(?<![\w$.])(?:tools\s*\.\s*)?spawn_agent\s*\(/g)?.length ?? 0;
  return { count, repeated: count > 0 && REPEATING.test(live) };
}

const TASK_EVENTS = new Set(["task_started", "task_complete"]);
const parent = (lines) => (lines[0]?.type === "session_meta" ? lines[0].payload?.parent_thread_id : null);
const running = (lines) => lines.filter((e) => e?.type === "event_msg" && TASK_EVENTS.has(e.payload?.type)).at(-1)?.payload.type === "task_started";

function sessionMeta(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1 << 16);
    const first = buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, buffer.length, 0)).split("\n")[0];
    const entry = JSON.parse(first);
    return entry.type === "session_meta" ? entry.payload : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The rollout files under a Codex home's `sessions` dir that descend from `thread`, through each
 * one's `session_meta.parent_thread_id`, so a delegate's own delegates count too. Only spawned
 * threads count: a guardian approval review names the same parent but is no delegate.
 */
export function childRollouts(sessions, thread) {
  const files = fs.existsSync(sessions)
    ? fs.readdirSync(sessions, { recursive: true }).map(String).filter((f) => /rollout-.*\.jsonl$/.test(f)).map((f) => path.join(sessions, f))
    : [];
  const metas = files.map((file) => ({ file, meta: sessionMeta(file) })).filter(({ meta }) => meta);
  const family = new Set([thread]);
  const found = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const { file, meta } of metas)
      if (!family.has(meta.id) && family.has(meta.parent_thread_id) && meta.source?.subagent?.thread_spawn) {
        family.add(meta.id);
        found.push(file);
        grew = true;
      }
  }
  return found;
}
