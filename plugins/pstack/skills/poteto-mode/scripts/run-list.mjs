import path from "node:path";

const SLUG_CHARS = "[A-Za-z0-9][A-Za-z0-9_-]*";

export const SLUG = new RegExp(`^${SLUG_CHARS}$`);

/** The run's todolist and decision trail in `dir`: `todo.md` and `decisions.tsv`, or `<slug>.todo.md` and `<slug>.tsv`. */
export function runFiles(dir, slug) {
	return {
		todo: path.resolve(dir, slug ? `${slug}.todo.md` : "todo.md"),
		trail: path.resolve(dir, slug ? `${slug}.tsv` : "decisions.tsv"),
	};
}
