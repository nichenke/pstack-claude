#!/usr/bin/env node
// Stop hook: blocks the main session's first stop when the latest todolist that
// open-run reported still has a step not checked off or marked skip:, n/a: or BLOCKED:.
// A second stop goes through.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENED } from "../skills/poteto-mode/scripts/run-list.mjs";

const openRun = fileURLToPath(new URL("../skills/poteto-mode/scripts/open-run.mjs", import.meta.url));

function resultTexts(entry) {
	const content = entry?.message?.content;
	if (entry?.type !== "user" || entry.isSidechain || !Array.isArray(content)) return [];
	return content
		.filter((block) => block?.type === "tool_result")
		.flatMap((block) =>
			typeof block.content === "string"
				? [block.content]
				: (block.content ?? []).filter((part) => part?.type === "text").map((part) => part.text),
		);
}

function latestTodo(transcript) {
	let latest = null;
	for (const line of fs.readFileSync(transcript, "utf8").split("\n")) {
		if (!line.includes("todo.md")) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		for (const text of resultTexts(entry)) for (const match of text.matchAll(OPENED)) latest = match[1];
	}
	return latest;
}

const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
if (input.stop_hook_active || !input.transcript_path || !fs.existsSync(input.transcript_path)) process.exit(0);

const todo = latestTodo(input.transcript_path);
if (!todo || !fs.existsSync(todo)) process.exit(0);

const check = spawnSync(process.execPath, [openRun, "--check", todo], { encoding: "utf8" });
if (check.status !== 1) process.exit(0);

process.stderr.write(
	[
		`poteto-mode: ${path.basename(path.dirname(todo))}/${path.basename(todo)} still has open steps.`,
		check.stdout.trim(),
		"Check off each step that is done, do the ones that are not, or keep a line with `skip: <reason>`.",
		"When a user or harness rule blocks a step, the reason names that rule. Then finish the reply.",
	].join("\n") + "\n",
);
process.exit(2);
