#!/usr/bin/env node
// Turns a plugin tree that strip-run-gate.sh already stripped into the native arm: the todolist
// becomes the runtime's own task tool, built from open-run's dry-run output verbatim.
// Usage: native-arm.mjs <plugin-root>
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const fail = (message) => {
  console.error(`native-arm: ${message}`);
  process.exit(1);
};

const root = process.argv[2] ?? fail("usage: native-arm.mjs <plugin-root>");
const skill = path.join(root, "skills/poteto-mode/SKILL.md");
if (!fs.existsSync(skill)) fail(`${root} is not a pstack plugin tree`);

const TODOLIST = "The todolist is the uncommitted `todo.md` that **Start the run** writes.";
const STEPS = [
  "2. Run `node <this skill's base directory>/scripts/open-run.mjs <playbook> <work-dir>`",
  "3. Work from the todolist.",
  "4. Before the final reply, run `node <this skill's base directory>/scripts/open-run.mjs --check",
];

const NATIVE_TODOLIST =
  "The todolist is the session's own task tool: `TaskCreate` and `TaskUpdate` on Claude Code, and `update_plan` on Codex. " +
  "On Claude Code they arrive deferred, so load them first with `ToolSearch` and the query `select:TaskCreate,TaskUpdate`. " +
  "Neither tool has a skip state. A step you drop is marked completed with `skip: <reason>`, in the task's description on Claude Code " +
  "and appended to the step's text on Codex.";
const NATIVE_STEPS = [
  "2. Run `node <this skill's base directory>/scripts/open-run.mjs --dry-run <playbook>`, which writes nothing, and create one task for each `- [ ]` line it prints, in order, " +
    "with the line's text verbatim as the task's subject on Claude Code or the step's text on Codex, the commit and PR gates included. " +
    "Then copy `<this skill's base directory>/../show-me-your-work/references/decision-log-template.tsv` to `decisions.tsv` in the session scratchpad, or in `.audit` when there is none, for the **show-me-your-work** skill. " +
    "Then read the playbook file. When a project playbook applies (see **Project playbooks**), pass a standalone one by its path; for one that extends a bundled playbook, open the bundled one by name and apply the project playbook's changes to the task list.",
  "3. Work from the task list. Mark each task completed as it lands and add a `decisions.tsv` row for each decision. A step you drop is marked completed with `skip: <reason>`.",
  "4. Before the final reply, list the tasks and resolve every one that is not completed.",
];

const lines = fs.readFileSync(skill, "utf8").split("\n");
const only = (prefix) => {
  const at = lines.flatMap((line, i) => (line.startsWith(prefix) ? [i] : []));
  if (at.length !== 1) fail(`expected one line starting ${JSON.stringify(prefix)} in ${skill}, found ${at.length}`);
  return at[0];
};
const todolist = only(TODOLIST);
const steps = STEPS.map(only);
if (steps.some((at, i) => at !== steps[0] + i)) fail(`expected steps 2 to 4 of Start the run on consecutive lines of ${skill}`);

lines[todolist] = NATIVE_TODOLIST;
lines.splice(steps[0], STEPS.length, ...NATIVE_STEPS);
const text = lines.join("\n");
const left = ["open-run.mjs --check", "open-run.mjs <playbook>", "`todo.md`", "Stop hook"].filter((phrase) => text.includes(phrase));
if (left.length) fail(`${skill} still names ${left.join(", ")} after the rewrite`);
fs.writeFileSync(skill, text);
