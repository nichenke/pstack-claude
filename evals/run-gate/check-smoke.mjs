#!/usr/bin/env node
// Checks smoke batches: one run per runtime and arm that exited 0 with a result (outcome clean or
// delegate-in-flight), each reporting a list of its arm's kind, and each todo-hook run recording
// whether run-gate held a stop.
// Usage: check-smoke.mjs [batch-dir...]   (default: the newest batch under results/)
// Prints "SMOKE-MATRIX-OK <runs>" and exits 0 only when every check passes.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadScores } from "./report.mjs";

const KIND = { native: "task-tool", todo: "open-run", "todo-hook": "open-run" };
const RUNTIMES = ["claude", "codex"];

export function checkSmoke(scores) {
  const problems = [];
  for (const runtime of RUNTIMES)
    for (const [arm, kind] of Object.entries(KIND)) {
      const runs = scores.filter((s) => (s.runtime ?? "claude") === runtime && s.arm === arm);
      const name = `${runtime} ${arm}`;
      if (runs.length !== 1) {
        problems.push(`${name}: ${runs.length} runs, expected 1`);
        continue;
      }
      const [s] = runs;
      if (s.exit !== 0 || s.outcome === "error" || s.outcome === "timeout") problems.push(`${name}: exit ${s.exit}, outcome ${s.outcome}`);
      if (s.list !== kind) problems.push(`${name}: list ${s.list}, expected ${kind}`);
      if (arm === "todo-hook" && typeof s.gateHeld !== "boolean") problems.push(`${name}: gateHeld not recorded`);
    }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
  const batches = process.argv.slice(2);
  if (!batches.length && fs.existsSync(results)) batches.push(path.join(results, fs.readdirSync(results).sort().at(-1) ?? ""));
  const scores = batches.flatMap((batch) => loadScores(batch));
  const problems = checkSmoke(scores);
  for (const problem of problems) console.log(problem);
  if (problems.length) process.exit(1);
  console.log(`SMOKE-MATRIX-OK ${scores.length}`);
}
