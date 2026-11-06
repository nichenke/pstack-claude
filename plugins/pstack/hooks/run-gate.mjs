#!/usr/bin/env node
// Stop hook: blocks the main session's first stop when the latest todolist that open-run reported
// with this session's id in its header still has a step not checked off or marked skip:, n/a: or
// BLOCKED:. A second stop goes through. So does a stop while `background_tasks` lists a live
// subagent or workflow, which wakes the session when it ends, or a live task launched by an agent
// waiting on its own background work, whose end can resume that agent and so notify the session.
// Claude Code leaves a waiting agent out of `background_tasks`, so its tasks are read from its
// sidechain transcript. Without `background_tasks`, a launched agent not yet notified lets the stop
// through and a waiting one does not. A sidechain it cannot read, or a launch in a shape it does not
// recognise, leaves the gate holding.
// On Codex the transcript is the thread's rollout, and the lists come from its CommandExecution
// items. Codex 0.165 gives the hook no background-work signal, so there the gate holds while a
// delegate runs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWaitingSummary, OPENED, ownedList } from "../skills/poteto-mode/scripts/run-list.mjs";

const openRun = fileURLToPath(new URL("../skills/poteto-mode/scripts/open-run.mjs", import.meta.url));

const WAKES = new Set(["subagent", "workflow"]);
const ENDED = new Set(["completed", "failed", "killed", "stopped"]);
const RELEVANT = /todo\.md|async_launched|"forked"|resumedAgentId|task-notification|"task_id"/;
// The harness's own launch results, matched at the start so a line the agent read elsewhere is not its launch.
const LAUNCH = /^(?:Command running in background with ID: ([^\s.]+)\.|Monitor started \(task ([^\s,)]+),)/;
const SHELL_RELEVANT = /Command running in background|Monitor started|backgroundTaskId|"persistent"/;

function texts(content) {
	if (typeof content === "string") return [content];
	return Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => part.text) : [];
}

function resultTexts(entry) {
	const content = entry.message?.content;
	if (entry.type !== "user" || !Array.isArray(content)) return [];
	return content.filter((block) => block?.type === "tool_result").flatMap((block) => texts(block.content));
}

function toolResult(entry) {
	const result = entry.toolUseResult;
	return entry.type === "user" && result && typeof result === "object" ? result : null;
}

function launched(entry) {
	const result = toolResult(entry);
	if (!result) return null;
	if (result.status === "async_launched") return result.agentId ?? result.taskId ?? null;
	if (result.status === "forked" && result.background === true) return result.agentId ?? null;
	return typeof result.resumedAgentId === "string" ? result.resumedAgentId : null;
}

function notified(entry) {
	const stopped = toolResult(entry)?.task_id;
	if (typeof stopped === "string") return [{ id: stopped, waiting: false }];
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
			const status = body.match(/<status>([^<]+)<\/status>/)?.[1];
			const result = body.indexOf("<result>");
			const own = body.indexOf("<summary>");
			const summary = own !== -1 && (result === -1 || own < result) ? (body.slice(own).match(/^<summary>([\s\S]*?)<\/summary>/)?.[1] ?? "") : "";
			const waiting = status === "completed" && isWaitingSummary(summary);
			if (id && ENDED.has(status)) ids.push({ id, waiting });
		}
	return ids;
}

function readTranscript(lines) {
	const opened = [];
	const running = new Map();
	for (const line of lines) {
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
			if (!notice.waiting) running.delete(notice.id);
			else if (running.has(notice.id)) running.set(notice.id, true);
	}
	const waiting = [...running].filter(([, isWaiting]) => isWaiting).map(([id]) => id);
	return { opened, running: running.size - waiting.length, waiting };
}

function launchedBy(agents, sessionDir) {
	const own = new Set();
	for (const agent of agents) {
		let lines;
		try {
			lines = fs.readFileSync(path.join(sessionDir, "subagents", `agent-${agent}.jsonl`), "utf8").split("\n");
		} catch {
			continue;
		}
		for (const line of lines) {
			if (!SHELL_RELEVANT.test(line)) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!entry) continue;
			const result = toolResult(entry);
			if (typeof result?.backgroundTaskId === "string") own.add(result.backgroundTaskId);
			else if (typeof result?.persistent === "boolean" && typeof result.taskId === "string") own.add(result.taskId);
			for (const text of resultTexts(entry)) {
				const [, shell, monitor] = text.match(LAUNCH) ?? [];
				if (shell ?? monitor) own.add(shell ?? monitor);
			}
		}
	}
	return own;
}

function readRollout(lines, thread) {
	const opened = [];
	for (const line of lines) {
		if (!line.includes('"CommandExecution"')) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const item = entry?.payload?.item;
		if (entry.type !== "event_msg" || entry.payload.type !== "item_completed" || item?.type !== "CommandExecution") continue;
		if (entry.payload.thread_id !== thread || typeof item.aggregated_output !== "string") continue;
		for (const match of item.aggregated_output.matchAll(OPENED)) opened.push(match[1]);
	}
	return { opened, running: 0, waiting: [] };
}

function isRollout(lines) {
	try {
		return JSON.parse(lines[0]).type === "session_meta";
	} catch {
		return false;
	}
}

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active || !input.transcript_path || !fs.existsSync(input.transcript_path)) process.exit(0);

const lines = fs.readFileSync(input.transcript_path, "utf8").split("\n");
const transcript = isRollout(lines) ? readRollout(lines, input.session_id) : readTranscript(lines);
const todo = ownedList(transcript.opened, input.session_id);
if (!todo) process.exit(0);

const check = spawnSync(process.execPath, [openRun, "--check", todo], { encoding: "utf8" });
if (check.status !== 1) process.exit(0);

const live = Array.isArray(input.background_tasks) ? input.background_tasks.filter((task) => !ENDED.has(task?.status)) : null;
const ownedBy = (tasks) => {
	const own = launchedBy(transcript.waiting, input.transcript_path.replace(/\.jsonl$/, ""));
	return tasks.some((task) => own.has(task?.id));
};
const busy = live
	? live.some((task) => WAKES.has(task?.type)) || (live.length > 0 && transcript.waiting.length > 0 && ownedBy(live))
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
