// Scores one `codex exec --json` run into the shape scoreStream returns for a Claude Code run.
import path from "node:path";
import { OPENED, RUN_FILE, TODO_FILE } from "../../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";
import { openRunPlaybook, taskCounts, TODO_REDIRECT } from "./score-common.mjs";

// A SKILL.md path, or a brace list of them, as in `cat skills/{deslop,no-comments}/SKILL.md`.
const SKILL_READ = /\/skills\/(?:([a-z0-9-]+)|\{([a-z0-9-]+(?:,[a-z0-9-]+)*)\})\/SKILL\.md\b/g;
const PLUGIN_ROOT = /(\/[^\s'"]*?)\/skills\/poteto-mode\//;
// codex exec reports its own --dangerously-bypass-hook-trust warning as an error item.
const HOOK_TRUST_WARNING = /dangerously-bypass-hook-trust/;

/**
 * `events` are the exec stream's lines, which carry only the main thread's items: a list opened, an
 * edit or a skill read by a delegate does not reach them. `rollout` is the thread's rollout file,
 * which alone records three things: each Stop hook block (a HookPrompt item), whether `update_plan`
 * was offered (code mode declares it inside the `exec` tool), and each `spawn_agent` call, which
 * code mode holds only as JavaScript source.
 * Codex reports no background work, so `delegatesInFlight` is null and `delegates` counts launches.
 * A skill counts as run when a command read its SKILL.md, since Codex has no skill tool.
 */
export function scoreCodex(events, rollout = []) {
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
  const skills = [];
  const commands = [];
  const todoHints = [];
  const trails = [];

  for (const event of events) {
    if (event.type === "thread.started") session ??= event.thread_id ?? null;
    if (event.type === "turn.completed") {
      completed = true;
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
    if (item.type === "error" && event.type === "item.completed" && !HOOK_TRUST_WARNING.test(String(item.message))) failed = true;
    if (event.type !== "item.completed") continue;

    let kind = null;
    if (item.type === "command_execution") {
      const command = String(item.command ?? "");
      commands.push(command);
      for (const [, name, names] of command.matchAll(SKILL_READ)) skills.push(...(name ? [name] : names.split(",")));
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

  let gateBlocks = 0;
  let delegates = 0;
  let taskTools = false;
  for (const entry of rollout) {
    const payload = entry?.payload;
    if (entry?.type === "event_msg" && payload?.type === "item_completed" && payload.item?.type === "HookPrompt") {
      if ((payload.item.fragments ?? []).some((part) => String(part?.text).includes("still has open steps"))) gateBlocks++;
    }
    if (entry?.type === "response_item" && payload?.type === "custom_tool_call") {
      delegates += (String(payload.input ?? "").match(/\bspawn_agent\s*\(/g) ?? []).length;
    }
    if (entry?.type === "response_item" && payload?.type === "additional_tools" && /\bupdate_plan\(/.test(JSON.stringify(payload.tools))) {
      taskTools = true;
    }
  }

  const native = (todos ?? []).map((todo) => ({ text: String(todo?.text ?? ""), note: "", done: todo?.completed === true }));
  return {
    list: { kind: list?.kind ?? null, beforeFirstEdit: Boolean(list) && (firstEdit === null || list.at < firstEdit) },
    firstEditSeen: firstEdit !== null,
    session,
    opened,
    written,
    todoHints,
    checkRan,
    gateBlocks,
    playbook: playbook && path.basename(playbook, ".md"),
    taskTools: taskTools || todos !== null,
    taskList: taskCounts(native),
    native: native.length ? native : null,
    delegatesInFlight: null,
    delegates,
    skills,
    commands,
    trails,
    plugin,
    tokens,
    result: { ok: completed && !failed, turns: null, ms: null, usd: null },
  };
}
