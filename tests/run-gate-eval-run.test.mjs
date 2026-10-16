import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const evalDir = join(import.meta.dir, "../evals/run-gate");
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !["TASKS", "ARMS", "BUDGET_USD", "RUN_MINUTES", "PARALLEL"].includes(key)),
);
const sh = (script, args, env = {}) =>
  spawnSync("bash", [join(evalDir, script), ...args], { encoding: "utf8", env: { ...clean, ...env } });
const dryRun = (env, ...args) => sh("run.sh", ["--dry-run", ...args], env);
const summary = (r) => r.stdout.trim().split("\n").at(-1);

describe("run.sh --dry-run", () => {
  test("selects the named tasks and arms and prices them from each task's settings", () => {
    const r = dryRun({ TASKS: "slugkit logsift", ARMS: "upstream hook" }, "2");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("slugkit 45 10\nlogsift 90 30\n");
    expect(summary(r)).toBe("8 runs on arms upstream hook, 3 at a time; cost ceiling $160.00");
  });

  test("defaults to every task on every arm", () => {
    expect(summary(dryRun({}, "1"))).toBe("12 runs on arms upstream prose hook, 3 at a time; cost ceiling $180.00");
  });

  test("an exported budget wins over task.env", () => {
    expect(summary(dryRun({ TASKS: "logsift", ARMS: "hook", BUDGET_USD: "2.5" }, "1"))).toEndWith("cost ceiling $2.50");
  });

  const refusals = {
    "an unknown task": [{ TASKS: "nope" }, "unknown task 'nope'"],
    "a path for a task": [{ TASKS: "../tasks/slugkit" }, "unknown task"],
    "an unknown arm": [{ ARMS: "prse" }, "unknown arm 'prse'"],
    "an arm named twice": [{ ARMS: "hook hook" }, "names an arm twice"],
    "an empty selection": [{ TASKS: " " }, "must each name at least one"],
    "zero reps": [{}, "reps must be", "0"],
  };
  for (const [name, [env, message, reps = "1"]] of Object.entries(refusals)) {
    test(`refuses ${name}`, () => {
      const r = dryRun(env, reps);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stdout).toBe("");
    });
  }
});

describe("task-settings.sh", () => {
  const task = (env) => {
    const dir = mkdtempSync(join(tmpdir(), "task-"));
    if (env !== undefined) writeFileSync(join(dir, "task.env"), env);
    return dir;
  };

  test("defaults without a task.env, reads one, and lets the environment win", () => {
    expect(sh("task-settings.sh", [task()]).stdout).toBe("45 10\n");
    expect(sh("task-settings.sh", [task("RUN_MINUTES=90\n\nBUDGET_USD=30")]).stdout).toBe("90 30\n");
    expect(sh("task-settings.sh", [task("RUN_MINUTES=90\n")], { RUN_MINUTES: "5" }).stdout).toBe("5 10\n");
  });

  for (const [name, env] of Object.entries({
    "an unknown key": "MODEL=haiku\n",
    "a fractional minute count": "RUN_MINUTES=1.5\n",
    "a zero budget": "BUDGET_USD=0.0\n",
    "a budget with a leading zero": "BUDGET_USD=07\n",
  })) {
    test(`exits 2 on ${name}`, () => expect(sh("task-settings.sh", [task(env)]).status).toBe(2));
  }
});
