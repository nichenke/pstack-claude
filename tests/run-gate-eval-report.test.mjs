import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minutes, report } from "../evals/run-gate/report.mjs";
import { checkSmoke } from "../evals/run-gate/check-smoke.mjs";
import { SCORER } from "../evals/run-gate/score.mjs";

const score = (over) => ({
  scorer: SCORER,
  pluginOk: true,
  task: "slugkit",
  runtime: "claude",
  arm: "todo",
  exit: 0,
  seconds: 600,
  ms: 120_000,
  outcome: "clean",
  gates: { deslop: "done", noComments: "missing", pr: "skipped" },
  ...over,
});
const row = (text, name) => text.split("\n").find((line) => line.startsWith(`| ${name} |`));

describe("report", () => {
  test("minutes come from the wall-clock seconds, not the main thread's duration_ms", () => {
    expect(minutes(score({ seconds: 5400, ms: 180_000 }))).toBe(90);
    expect(row(report("b", [score({ seconds: 5400, ms: 180_000 })]), "minutes (mean)")).toBe("| minutes (mean) | 90.0 |");
  });

  test("a timed-out or failed run is not counted as finished clean, and a live delegate is its own outcome", () => {
    const text = report("b", [
      score({ exit: 124, outcome: "timeout" }),
      score({ exit: 1, outcome: "error" }),
      score({ outcome: "delegate-in-flight", delegatesInFlight: 1 }),
      score({}),
    ]);
    expect(row(text, "runs finished clean")).toBe("| runs finished clean | 1/4 |");
    expect(row(text, "outcome clean / delegate-in-flight / unknown / timeout / error")).toBe(
      "| outcome clean / delegate-in-flight / unknown / timeout / error | 1 / 1 / 0 / 1 / 1 |",
    );
    expect(row(text, "runs ended with a delegate in flight")).toBe("| runs ended with a delegate in flight | 1/4 |");
  });

  test("has one column per runtime and arm present, in a fixed order", () => {
    const text = report("b", [score({ runtime: "codex", arm: "native" }), score({ arm: "todo-hook" }), score({ arm: "native" })]);
    expect(text).toContain("| Metric | claude native | claude todo-hook | codex native |");
  });

  test("reports verbatim fidelity as the mean share of playbook steps kept", () => {
    const text = report("b", [score({ fidelity: { steps: 4, matched: 4 } }), score({ fidelity: { steps: 4, matched: 2 } }), score({ fidelity: null })]);
    expect(row(text, "playbook steps kept verbatim (mean %)")).toBe("| playbook steps kept verbatim (mean %) | 75.0 |");
  });
});

describe("checkSmoke", () => {
  const smoke = () =>
    ["claude", "codex"].flatMap((runtime) => [
      score({ runtime, arm: "native", list: "task-tool" }),
      score({ runtime, arm: "todo", list: "open-run" }),
      score({ runtime, arm: "todo-hook", list: "open-run", gateHeld: false }),
    ]);

  test("passes one finished run per runtime and arm with the arm's list kind", () => expect(checkSmoke(smoke())).toEqual([]));

  test("names a missing run, a failed run, a wrong list kind and an unrecorded gate", () => {
    const runs = smoke();
    runs[0].list = "open-run";
    runs[1].outcome = "error";
    runs[2].outcome = "unknown";
    runs[2].pluginOk = false;
    runs[2].stopErrors = 1;
    runs[2].scorer = 1;
    runs[5].gateHeld = null;
    expect(checkSmoke(runs.filter((s) => !(s.runtime === "codex" && s.arm === "todo")))).toEqual([
      "claude native: list open-run, expected task-tool",
      "claude todo: exit 0, outcome error",
      "claude todo-hook: scored by scorer 1, not " + SCORER,
      "claude todo-hook: the arm's plugin did not load",
      "claude todo-hook: exit 0, outcome unknown",
      "claude todo-hook: 1 Stop hook errors",
      "codex todo: 0 runs, expected 1",
      "codex todo-hook: gateHeld not recorded",
    ]);
  });
});

describe("report.mjs as a command", () => {
  test("names the jobs with no score and exits 1, run through a symlinked path", () => {
    const root = mkdtempSync(join(tmpdir(), "report-"));
    const batch = join(root, "batch");
    mkdirSync(join(batch, "runs/slugkit-claude-todo-1"), { recursive: true });
    writeFileSync(join(batch, "jobs.txt"), "slugkit claude todo 1\nslugkit codex todo 1\n");
    writeFileSync(join(batch, "runs/slugkit-claude-todo-1/score.json"), JSON.stringify(score({})));
    const link = join(root, "link");
    symlinkSync(join(import.meta.dir, "../evals/run-gate"), link);
    const r = spawnSync("node", [join(link, "report.mjs"), batch], { encoding: "utf8" });
    expect(r.stdout).toContain("1 scored runs.");
    expect(r.stdout).toContain("**1 of 2 jobs have no score:** slugkit-codex-todo-1.");
    expect(r.status).toBe(1);
    writeFileSync(join(batch, "jobs.txt"), "slugkit claude todo 1\n");
    expect(spawnSync("node", [join(link, "report.mjs"), batch], { encoding: "utf8" }).status).toBe(0);
  });
});
