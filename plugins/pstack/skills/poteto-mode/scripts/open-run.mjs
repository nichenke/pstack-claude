#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runFiles, SLUG } from "./run-list.mjs";

const mode = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skills = path.dirname(mode);
const playbooks = path.join(mode, "playbooks");
const trailHeader = path.join(skills, "show-me-your-work/references/decision-log-template.tsv");

const PR_GATES = [
	"Run `/deslop` over the diff before commit.",
	"Run `/no-comments` before review.",
	"Run **Opening a PR**, or keep this line with `skip: <the user or harness rule that blocks it>`.",
];

const usage = () => {
	const names = fs.readdirSync(playbooks).map((f) => f.replace(/\.md$/, ""));
	console.error("Usage: node open-run.mjs [--slug <task-slug>] <playbook | path/to/playbook.md> <work-dir>");
	console.error("       node open-run.mjs --check <todo.md | task-slug.todo.md>");
	console.error(`Playbooks: figure-it-out, ${names.sort().join(", ")}`);
	process.exit(2);
};

function outsideFences(text) {
	const kept = [];
	let fence = null;
	for (const line of text.split(/\r?\n/)) {
		const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fence) {
			if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length) fence = null;
			continue;
		}
		if (delimiter) {
			fence = delimiter[1];
			continue;
		}
		kept.push(line);
	}
	return kept;
}

function numberedSteps(lines) {
	const steps = [];
	for (const line of lines) {
		if (/^\d+\. /.test(line)) steps.push([line]);
		else if (steps.length && /^\s+\S/.test(line)) steps.at(-1).push(line);
		else if (steps.length && line.trim() !== "") steps.push(null);
	}
	return steps.filter(Boolean);
}

function phaseSteps(lines) {
	return lines.filter((line) => /^## Phase /.test(line)).map((line) => [line.replace(/^## /, "")]);
}

function open(playbook, dir, slug) {
	const project = playbook.endsWith(".md");
	const name = project ? path.basename(playbook, ".md") : playbook;
	const figure = !project && name === "figure-it-out";
	const source = project
		? path.resolve(playbook)
		: figure
			? path.join(skills, "figure-it-out/SKILL.md")
			: path.join(playbooks, `${name}.md`);
	if (!(project || /^[a-z-]+$/.test(name)) || !fs.existsSync(source)) usage();

	const text = fs.readFileSync(source, "utf8").replace(/^\uFEFF/, "");
	const front = project ? (text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)?.[1] ?? "") : "";
	const bases = (front.match(/^extends:[ \t]*(.*)$/m)?.[1] ?? "")
		.split(",")
		.map((stem) => stem.trim())
		.filter(Boolean);
	if (bases.length) {
		console.error(`${playbook} extends ${bases.join(", ")}. Open the bundled playbook by name, then apply its changes to the todolist.`);
		process.exit(2);
	}
	const lines = outsideFences(text);
	const steps = figure ? phaseSteps(lines) : numberedSteps(lines);
	const shipsCode = figure || name === "opening-a-pr" || text.includes("**Opening a PR**");

	fs.mkdirSync(dir, { recursive: true });
	const { todo, trail } = runFiles(dir, slug);

	if (fs.existsSync(todo)) {
		console.log(`${todo} exists; left as is`);
	} else {
		const body = [`# ${name}`, "", `Steps copied from ${project ? source : path.relative(skills, source)}.`, ""];
		for (const step of steps) body.push(`- [ ] ${step[0]}`, ...step.slice(1));
		if (shipsCode) body.push("", "## Commit and PR gates", "", ...PR_GATES.map((gate) => `- [ ] ${gate}`));
		fs.writeFileSync(todo, body.join("\n") + "\n");
		console.log(`${todo}: ${steps.length} steps${shipsCode ? `, ${PR_GATES.length} PR gates` : ""}`);
	}

	if (fs.existsSync(trail)) console.log(`${trail} exists; left as is`);
	else {
		fs.copyFileSync(trailHeader, trail);
		console.log(`${trail}: started`);
	}
}

function check(file) {
	const open = [];
	fs.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.forEach((line, i) => {
			if (!line.startsWith("- [ ] ")) return;
			if (/\b(skip|n\/a): *(?!`?<)\S/.test(line)) return;
			open.push(`${file}:${i + 1}: ${line.slice(6)}`);
		});
	for (const line of open) console.log(line);
	console.log(`${open.length} open`);
	process.exit(open.length ? 1 : 0);
}

let args;
try {
	args = parseArgs({ allowPositionals: true, options: { check: { type: "boolean" }, slug: { type: "string" } } });
} catch {
	usage();
}
const { values, positionals } = args;
if (values.check) {
	if (positionals.length !== 1 || values.slug !== undefined) usage();
	check(positionals[0]);
} else {
	if (positionals.length !== 2) usage();
	if (values.slug !== undefined && !SLUG.test(values.slug)) {
		console.error(`--slug ${JSON.stringify(values.slug)}: use ASCII letters, digits, - and _, starting with a letter or digit.`);
		process.exit(2);
	}
	open(positionals[0], positionals[1], values.slug);
}
