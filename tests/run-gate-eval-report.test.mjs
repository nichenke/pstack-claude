import { describe, expect, test } from "bun:test";
import { minutes, report } from "../evals/run-gate/report.mjs";
import { checkSmoke } from "../evals/run-gate/check-smoke.mjs";

const score = (over) => ({
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
    expect(row(text, "outcome clean / delegate-in-flight / timeout / error")).toBe("| outcome clean / delegate-in-flight / timeout / error | 1 / 1 / 1 / 1 |");
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
    runs[1].exit = 124;
    delete runs[5].gateHeld;
    expect(checkSmoke(runs.filter((s) => !(s.runtime === "codex" && s.arm === "todo")))).toEqual([
      "claude native: list open-run, expected task-tool",
      "claude todo: exit 124, outcome clean",
      "codex todo: 0 runs, expected 1",
      "codex todo-hook: gateHeld not recorded",
    ]);
  });
});
