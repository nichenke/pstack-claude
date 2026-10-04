#!/usr/bin/env node
// Aggregates every runs/*/score.json in a batch into one Markdown table per arm.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const batch = process.argv[2];
const runs = path.join(batch, "runs");
const scores = fs
  .readdirSync(runs)
  .map((dir) => path.join(runs, dir, "score.json"))
  .filter((file) => fs.existsSync(file))
  .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const arms = ["upstream", "prose", "hook"];
const rate = (rows, pick) => `${rows.filter(pick).length}/${rows.length}`;
const mean = (rows, pick) => {
  const values = rows.map(pick).filter((v) => typeof v === "number" && !Number.isNaN(v));
  return values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : "-";
};
const gates = (rows, key) =>
  ["done", "skipped", "claimed", "missing"].map((g) => `${rows.filter((r) => r.gates[key] === g).length}`).join(" / ");

const metrics = [
  ["runs finished without error", (r) => rate(r, (s) => s.ok)],
  ["plugin arm loaded", (r) => rate(r, (s) => s.pluginOk)],
  ["list opened before first edit", (r) => rate(r, (s) => s.listBeforeFirstEdit)],
  ["list kind open-run / task-tool / todo.md", (r) => ["open-run", "task-tool", "todo.md"].map((k) => r.filter((s) => s.list === k).length).join(" / ")],
  ["todo.md kept", (r) => rate(r, (s) => s.todoKept)],
  ["todo.md fully resolved at the end", (r) => rate(r, (s) => s.openSteps === 0)],
  ["ran --check", (r) => rate(r, (s) => s.checkRan)],
  ["stops held by run-gate (mean)", (r) => mean(r, (s) => s.gateBlocks)],
  ["decision rows (mean)", (r) => mean(r, (s) => s.decisionRows)],
  ["deslop done / skipped / claimed / missing", (r) => gates(r, "deslop")],
  ["no-comments done / skipped / claimed / missing", (r) => gates(r, "noComments")],
  ["PR done / skipped / claimed / missing", (r) => gates(r, "pr")],
  ["commits made", (r) => rate(r, (s) => s.commits > 0)],
  ["visible tests pass", (r) => rate(r, (s) => s.visibleTests)],
  ["held-out tests pass", (r) => rate(r, (s) => s.hiddenTests)],
  ["turns (mean)", (r) => mean(r, (s) => s.turns)],
  ["minutes (mean)", (r) => mean(r, (s) => (s.ms ?? s.seconds * 1000) / 60000)],
  ["USD (mean)", (r) => mean(r, (s) => s.usd)],
];

const byArm = Object.fromEntries(arms.map((arm) => [arm, scores.filter((s) => s.arm === arm)]));
const lines = [
  `# run-gate eval: ${path.basename(batch)}`,
  "",
  `${scores.length} scored runs. Total USD ${scores.reduce((a, s) => a + (s.usd ?? 0), 0).toFixed(2)}.`,
  "",
  `| Metric | ${arms.join(" | ")} |`,
  `| --- | ${arms.map(() => "---").join(" | ")} |`,
  ...metrics.map(([name, fn]) => `| ${name} | ${arms.map((arm) => fn(byArm[arm])).join(" | ")} |`),
  "",
  "## Held-out tests by task",
  "",
  `| Task | ${arms.join(" | ")} |`,
  `| --- | ${arms.map(() => "---").join(" | ")} |`,
  ...["slugkit", "tally", "confload"].map(
    (task) => `| ${task} | ${arms.map((arm) => rate(byArm[arm].filter((s) => s.task === task), (s) => s.hiddenTests)).join(" | ")} |`,
  ),
];
console.log(lines.join("\n"));
