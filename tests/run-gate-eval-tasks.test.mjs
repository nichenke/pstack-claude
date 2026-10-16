import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tasksDir = join(import.meta.dir, "../evals/run-gate/tasks");
const tasks = readdirSync(tasksDir);
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

function copy(task, patch) {
  const dir = join(mkdtempSync(join(tmpdir(), "task-")), task);
  cpSync(join(tasksDir, task, "repo"), dir, { recursive: true });
  if (patch) {
    const applied = spawnSync("patch", ["-p1", "--forward", "--input", patch], { cwd: dir, encoding: "utf8" });
    expect(applied.stderr).toBe("");
    expect(applied.status).toBe(0);
  }
  cpSync(join(tasksDir, task, "hidden", "test_hidden.py"), join(dir, "test_hidden.py"));
  return dir;
}

const unittest = (dir, ...args) => spawnSync("python3", ["-m", "unittest", ...args], { cwd: dir, encoding: "utf8", env });

describe.each(tasks)("task %s", (task) => {
  test("has a prompt, a repo whose visible tests pass, and held-out tests that fail on it", () => {
    expect(readFileSync(join(tasksDir, task, "prompt.txt"), "utf8").trim()).not.toBe("");
    const dir = copy(task);
    expect(unittest(dir, "discover", "-s", "tests", "-t", ".").status).toBe(0);
    expect(unittest(dir, "test_hidden").status).toBe(1);
  });

  const patch = join(tasksDir, task, "reference.patch");
  test.if(existsSync(patch))("passes every held-out and visible test once reference.patch is applied", () => {
    const dir = copy(task, patch);
    const hidden = unittest(dir, "test_hidden");
    expect(hidden.stderr).toMatch(/\nOK\n$/);
    expect(unittest(dir, "discover", "-s", "tests", "-t", ".").status).toBe(0);
  });
});
