#!/usr/bin/env node
// Stop hook: blocks the main session's first stop when the latest todolist that open-run reported
// with this session's id in its header still has a step not checked off or marked skip:, n/a: or
// BLOCKED:. A second stop goes through, and so does a stop while a background agent or workflow
// runs, since its completion wakes the session again. Background detection only ever lets a stop
// through: with no `background_tasks` input and no launch record it recognises, the gate holds.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENED, ownedList } from "../skills/poteto-mode/scripts/run-list.mjs";

const openRun = fileURLToPath(new URL("../skills/poteto-mode/scripts/open-run.mjs", import.meta.url));

const WAKES = new Set(["subagent", "workflow"]);
const ENDED = new Set(["completed", "failed", "killed", "stopped"]);
const RELEVANT = /todo\.md|async_launched|"forked"|resumedAgentId|task-notification|"task_id"/;
// Claude Code notifies an agent whose own background work still runs as completed with this summary,
// leaves it out of background_tasks, and notifies the same task id again once that work finishes.
const WAITING = /<summary>.* is waiting on its own background work<\/summary>/;

function texts(content) {
	if (typeof content === "string") return [content];
	return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text) : [];
}

function resultTexts(entry) {
	const content = entry.message?.content;
	if (entry.type !== "user" || !Array.isArray(content)) return [];
	return content.filter((block) => block?.type === "tool_result").flatMap((block) => texts(block.content));
}

function launched(entry) {
	const result = entry.toolUseResult;
	if (entry.type !== "user" || !result || typeof result !== "object") return null;
	if (result.status === "async_launched") return result.agentId ?? result.taskId ?? null;
	if (result.status === "forked" && result.background === true) return result.agentId ?? null;
	return typeof result.resumedAgentId === "string" ? result.resumedAgentId : null;
}

function notified(entry) {
	if (entry.type === "user" && typeof entry.toolUseResult?.task_id === "string")
		return [{ id: entry.toolUseResult.task_id, waiting: false }];
	const notice =
		entry.type === "user" && entry.origin?.kind === "task-notification"
			? entry.message?.content
			: entry.type === "attachment" && entry.attachment?.commandMode === "task-notification"
				? entry.attachment.prompt
				: null;
	const ids = [];
	for (const text of texts(notice))
		for (const [, body] of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
			const id = body.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
			if (id && ENDED.has(body.match(/<status>([^<]+)<\/status>/)?.[1])) ids.push({ id, waiting: WAITING.test(body) });
		}
	return ids;
}

function readTranscript(file) {
	const opened = [];
	const running = new Map();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!RELEVANT.test(line)) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || entry.isSidechain) continue;
		for (const text of resultTexts(entry)) for (const match of text.matchAll(OPENED)) opened.push(match[1]);
		const id = launched(entry);
		if (id) running.set(id, false);
		for (const notice of notified(entry))
			if (notice.waiting) running.set(notice.id, true);
			else running.delete(notice.id);
	}
	return { opened, running: running.size, waiting: [...running.values()].includes(true) };
}

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active || !input.transcript_path || !fs.existsSync(input.transcript_path)) process.exit(0);

const transcript = readTranscript(input.transcript_path);
const todo = ownedList(transcript.opened, input.session_id);
if (!todo) process.exit(0);

const check = spawnSync(process.execPath, [openRun, "--check", todo], { encoding: "utf8" });
if (check.status !== 1) process.exit(0);

const busy = Array.isArray(input.background_tasks)
	? input.background_tasks.some(
			(task) => !ENDED.has(task?.status) && (WAKES.has(task?.type) || transcript.waiting),
		)
	: transcript.running > 0;
if (busy) process.exit(0);

process.stderr.write(
	[
		`poteto-mode: ${path.basename(path.dirname(todo))}/${path.basename(todo)} still has open steps.`,
		check.stdout.trim(),
		"Check off each step that is done, do the ones that are not, or keep a line with `skip: <reason>`.",
		"When a user or harness rule blocks a step, the reason names that rule. Then finish the reply.",
	].join("\n") + "\n",
);
process.exit(2);
