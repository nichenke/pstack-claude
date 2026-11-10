#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const mode = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skills = path.dirname(mode);
const playbooks = path.join(mode, "playbooks");

const PR_GATES = [
	"Run `/deslop` over the diff before commit.",
	"Run `/no-comments` before review.",
	"Run **Opening a PR**, or mark this completed with `skip: <the user or harness rule that blocks it>`.",
];

const usage = (reason) => {
	if (reason) console.error(`open-run: ${reason}`);
	const names = fs.readdirSync(playbooks).map((f) => f.replace(/\.md$/, ""));
	console.error("Usage: node open-run.mjs --dry-run <playbook | path/to/playbook.md>");
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
	let open = false;
	for (const line of lines) {
		if (/^\d+\. /.test(line)) {
			steps.push([line]);
			open = true;
		} else if (open && /^\s+\S/.test(line)) steps.at(-1).push(line);
		else if (line.trim() !== "") open = false;
	}
	return steps;
}

function phaseSteps(lines) {
	return lines.filter((line) => /^## Phase /.test(line)).map((line) => [line.replace(/^## /, "")]);
}

function print(playbook) {
	const project = playbook.endsWith(".md");
	const name = project ? path.basename(playbook, ".md") : playbook;
	const figure = !project && name === "figure-it-out";
	const source = project
		? path.resolve(playbook)
		: figure
			? path.join(skills, "figure-it-out/SKILL.md")
			: path.join(playbooks, `${name}.md`);
	if (!(project || /^[a-z-]+$/.test(name)) || !fs.statSync(source, { throwIfNoEntry: false })?.isFile())
		usage(project ? `no playbook file at ${source}` : `no playbook named ${playbook}`);

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

	const body = [`# ${name}`, "", `Steps copied from ${project ? source : path.relative(skills, source)}.`, ""];
	for (const step of steps) body.push(`- [ ] ${step[0]}`, ...step.slice(1));
	const unwritten = !steps.length && !shipsCode;
	if (unwritten) body.push(`- [ ] ${name} has no numbered steps. Write the run's own steps as tasks, then complete this one.`);
	if (shipsCode) body.push("", "## Commit and PR gates", "", ...PR_GATES.map((gate) => `- [ ] ${gate}`));
	const counts = `${steps.length} steps${unwritten ? ", 1 to write" : ""}${shipsCode ? `, ${PR_GATES.length} PR gates` : ""}`;

	console.log(`${body.join("\n")}\n\ndry run, nothing written: ${counts}`);
}

let args;
try {
	args = parseArgs({ allowPositionals: true, options: { "dry-run": { type: "boolean" } } });
} catch (error) {
	usage(error.message);
}
const { values, positionals } = args;
if (!values["dry-run"]) usage("--dry-run is required");
if (positionals.length !== 1) usage(`expected one playbook argument, got ${positionals.length}`);
print(positionals[0]);
