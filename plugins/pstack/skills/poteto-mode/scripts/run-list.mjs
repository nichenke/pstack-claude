import fs from "node:fs";
import path from "node:path";

const SLUG_CHARS = "[A-Za-z0-9][A-Za-z0-9_-]*";
const SEP = String.raw`[\\/]`;

export const SLUG = new RegExp(`^${SLUG_CHARS}$`);

export const TODO_FILE = new RegExp(`(?:^|${SEP})(?:${SLUG_CHARS}\\.)?todo\\.md$`);

export const RUN_FILE = new RegExp(`(?:^|${SEP})(?:(?:${SLUG_CHARS}\\.)?todo\\.md|${SLUG_CHARS}\\.tsv)$`);

/**
 * Matches each line open-run.mjs prints for a list it wrote or found, capturing the list's
 * absolute path: POSIX, drive-letter, or UNC.
 */
export const OPENED = new RegExp(
	String.raw`^((?:/|[A-Za-z]:${SEP}|\\\\).*?${SEP}(?:${SLUG_CHARS}\.)?todo\.md)(?:: \d+ steps| exists; left as is)`,
	"gm",
);

/** A todolist line with a `skip:`, `n/a:` or upstream's `BLOCKED:` reason that is not empty or a `<placeholder>`. */
export const RESOLVED = /(?:\b(?:skip|n\/a)|\bBLOCKED): *(?!`?<)\S/;

/** The run's todolist and decision trail in `dir`: `todo.md` and `decisions.tsv`, or `<slug>.todo.md` and `<slug>.tsv`. */
export function runFiles(dir, slug) {
	return {
		todo: path.resolve(dir, slug ? `${slug}.todo.md` : "todo.md"),
		trail: path.resolve(dir, slug ? `${slug}.tsv` : "decisions.tsv"),
	};
}

/** The decision trail runFiles pairs with the todolist at `todo`. */
export function trailBeside(todo) {
	const slug = path.basename(todo).match(new RegExp(`^(${SLUG_CHARS})\\.todo\\.md$`))?.[1];
	return runFiles(path.dirname(todo), slug).trail;
}

/** The header line open-run writes into a list it creates, naming the Claude Code session that owns it. */
export const sessionHeader = (id) => `Session: ${id}`;

const SESSION_LINE = new RegExp(`^Session: (${SLUG_CHARS})$`);

/** The session id in a list's header, the lines above its first checkbox, or null when it has none. */
export function listSession(text) {
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("- [")) break;
		const id = line.match(SESSION_LINE)?.[1];
		if (id) return id;
	}
	return null;
}

const readList = (file) => {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
};

/**
 * The list a session's transcript points at: walking `opened` back from the latest path, the first
 * list whose header names `session`. A list held by another session or by none is passed over. A
 * list that is gone ends the walk with null, so a superseded list is never revived. `read` returns
 * a list's text, or null when it cannot.
 */
export function ownedList(opened, session, read = readList) {
	for (const file of [...opened].reverse()) {
		const text = read(file);
		if (text === null) return null;
		if (session && listSession(text) === session) return file;
	}
	return null;
}
