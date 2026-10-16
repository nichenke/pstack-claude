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
