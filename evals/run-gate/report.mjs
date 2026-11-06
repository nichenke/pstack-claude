#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { SCORER } from "./score.mjs";

const RUNTIMES = ["claude", "codex"];
const ARMS = ["native", "todo", "todo-hook"];
const OUTCOMES = ["clean", "delegate-in-flight", "unknown", "timeout", "error"];

/** The jobs a batch ran, from its jobs.txt, as run directory names; empty when it has none. */
export function batchJobs(batch) {
  const file = path.join(batch, "jobs.txt");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").join("-"));
}

/** The lines a report opens with when the batch is incomplete or mixes scorers; empty when it is whole. */
export function problems(batch, scores) {
  const scored = new Set(fs.existsSync(path.join(batch, "runs")) ? fs.readdirSync(path.join(batch, "runs")).filter((dir) => fs.existsSync(path.join(batch, "runs", dir, "score.json"))) : []);
  const unscored = batchJobs(batch).filter((job) => !scored.has(job));
  const stale = scores.filter((s) => s.scorer !== SCORER).length;
  return [
    ...(unscored.length ? [`**${unscored.length} of ${unscored.length + scored.size} jobs have no score:** ${unscored.join(", ")}. See errors.log. Every rate below leaves them out.`] : []),
    ...(stale ? [`**${stale} runs were scored by another scorer version than ${SCORER}.** Rescore them with score.mjs before comparing.`] : []),
  ];
}

export function loadScores(batch) {
  const runs = path.join(batch, "runs");
  return fs
    .readdirSync(runs)
    .map((dir) => path.join(runs, dir, "score.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}

const rate = (rows, pick) => `${rows.filter(pick).length}/${rows.length}`;
const mean = (rows, pick) => {
  const values = rows.map(pick).filter((v) => typeof v === "number" && !Number.isNaN(v));
  return values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : "-";
};
const counts = (rows, pick) => {
  const seen = Object.entries(Object.groupBy(rows.map(pick).filter(Boolean), (v) => v));
  return seen.length ? seen.map(([k, v]) => `${k} ${v.length}`).sort().join(", ") : "-";
};
const kept = (s) => s.taskList?.total > 0;
const resolved = (s) => (s.todoKept || kept(s)) && (!s.todoKept || s.openSteps === 0) && (!kept(s) || s.taskList.open === 0);
/** Wall-clock minutes. `duration_ms` covers only the main thread's last stretch in a run that delegates. */
export const minutes = (s) => (typeof s.seconds === "number" ? s.seconds / 60 : NaN);
const gates = (rows, key) =>
  ["done", "skipped", "claimed", "missing"].map((g) => `${rows.filter((r) => r.gates[key] === g).length}`).join(" / ");
const share = (s) => (s.fidelity ? (100 * s.fidelity.matched) / s.fidelity.steps : NaN);

const metrics = [
  ["runs finished clean", (r) => rate(r, (s) => s.outcome === "clean")],
  [`outcome ${OUTCOMES.join(" / ")}`, (r) => OUTCOMES.map((o) => r.filter((s) => s.outcome === o).length).join(" / ")],
  ["runs ended with a delegate in flight", (r) => rate(r, (s) => s.delegatesInFlight > 0)],
  ["delegates launched (mean)", (r) => mean(r, (s) => s.delegates)],
  ["plugin arm loaded", (r) => rate(r, (s) => s.pluginOk)],
  ["list opened before first edit", (r) => rate(r, (s) => s.listBeforeFirstEdit)],
  ["list kind open-run / task-tool / todo.md", (r) => ["open-run", "task-tool", "todo.md"].map((k) => r.filter((s) => s.list === k).length).join(" / ")],
  ["playbook steps kept verbatim (mean %)", (r) => mean(r, share)],
  ["todo.md kept", (r) => rate(r, (s) => s.todoKept)],
  ["todo.md fully resolved at the end", (r) => rate(r, (s) => s.openSteps === 0)],
  ["task tools offered", (r) => rate(r, (s) => s.taskTools)],
  ["task-tool list kept", (r) => rate(r, kept)],
  ["task-tool list fully resolved at the end", (r) => rate(r, (s) => kept(s) && s.taskList.open === 0)],
  ["task-tool steps skipped with a reason (mean)", (r) => mean(r.filter(kept), (s) => s.taskList.skipped)],
  ["every list kept fully resolved", (r) => rate(r, resolved)],
  ["playbook routed", (r) => counts(r, (s) => s.playbook)],
  ["ran --check", (r) => rate(r, (s) => s.checkRan)],
  ["runs with a stop held by run-gate", (r) => rate(r, (s) => s.gateBlocks > 0)],
  ["stops held by run-gate (mean)", (r) => mean(r, (s) => s.gateBlocks)],
  ["decision rows (mean)", (r) => mean(r, (s) => s.decisionRows)],
  ["deslop done / skipped / claimed / missing", (r) => gates(r, "deslop")],
  ["no-comments done / skipped / claimed / missing", (r) => gates(r, "noComments")],
  ["PR done / skipped / claimed / missing", (r) => gates(r, "pr")],
  ["commits made", (r) => rate(r, (s) => s.commits > 0)],
  ["visible tests pass", (r) => rate(r, (s) => s.visibleTests)],
  ["held-out tests pass", (r) => rate(r, (s) => s.hiddenTests)],
  ["turns (mean)", (r) => mean(r, (s) => s.turns)],
  ["minutes (mean)", (r) => mean(r, minutes)],
  ["USD (mean)", (r) => mean(r, (s) => s.usd)],
  ["output tokens (mean)", (r) => mean(r, (s) => s.tokens?.output_tokens)],
];

export function report(batch, scores = loadScores(batch)) {
  const runtime = (s) => s.runtime ?? "claude";
  const columns = RUNTIMES.flatMap((rt) => ARMS.map((arm) => ({ rt, arm, name: `${rt} ${arm}` }))).filter((c) =>
    scores.some((s) => runtime(s) === c.rt && s.arm === c.arm),
  );
  const tasks = [...new Set(scores.map((s) => s.task))].sort();
  const rows = Object.fromEntries(columns.map((c) => [c.name, scores.filter((s) => runtime(s) === c.rt && s.arm === c.arm)]));
  const table = (header, lines) => [
    `| ${header} | ${columns.map((c) => c.name).join(" | ")} |`,
    `| --- | ${columns.map(() => "---").join(" | ")} |`,
    ...lines,
  ];
  return [
    `# run-gate eval: ${path.basename(batch)}`,
    "",
    `${scores.length} scored runs. Claude USD ${scores.reduce((a, s) => a + (s.usd ?? 0), 0).toFixed(2)}.`,
    "",
    ...problems(batch, scores).flatMap((line) => [line, ""]),
    ...table("Metric", metrics.map(([name, fn]) => `| ${name} | ${columns.map((c) => fn(rows[c.name])).join(" | ")} |`)),
    ...[
      ["Held-out tests by task", (r) => rate(r, (s) => s.hiddenTests)],
      ["Minutes (mean) by task", (r) => mean(r, minutes)],
      ["Runs finished clean, by task", (r) => rate(r, (s) => s.outcome === "clean")],
      ["Runs with a stop held by run-gate, by task", (r) => rate(r, (s) => s.gateBlocks > 0)],
      ["Every list kept fully resolved, by task", (r) => rate(r, resolved)],
    ].flatMap(([title, fn]) => [
      "",
      `## ${title}`,
      "",
      ...table("Task", tasks.map((task) => `| ${task} | ${columns.map((c) => fn(rows[c.name].filter((s) => s.task === task))).join(" | ")} |`)),
    ]),
  ].join("\n");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scores = loadScores(process.argv[2]);
  console.log(report(process.argv[2], scores));
  if (problems(process.argv[2], scores).length) process.exitCode = 1;
}
