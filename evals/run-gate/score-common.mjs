import { RESOLVED } from "../../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";

// A shell redirect into a *todo*.md file; `2>&1` and plain reads don't match.
export const TODO_REDIRECT = /(?:^|[^>2&])>{1,2}\s*["']?([^\s"'|;&<>]*todo[^\s"'|;&<>]*\.md)\b/gi;
export const ENDED = new Set(["completed", "failed", "killed", "stopped"]);
// Claude Code 2.1.302 notifies an agent still waiting on its own background work as completed with this
// summary; fork PR #2 teaches run-gate the same rule.
export const WAITING = " is waiting on its own background work";
export const DELEGATE = /agent|workflow/;

export function openRunPlaybook(command) {
  if (!/open-run\.mjs\b/.test(command) || /--check\b/.test(command)) return null;
  return command.match(/open-run\.mjs\s+(?:--(?:slug\s+\S+|dry-run)\s+)*["']?([^\s"';&|)]+)/)?.[1] ?? null;
}

export function taskCounts(items) {
  if (!items?.length) return null;
  return {
    total: items.length,
    open: items.filter((item) => !item.done).length,
    skipped: items.filter((item) => item.done && RESOLVED.test(`${item.text} ${item.note}`)).length,
  };
}

