import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skills = join(import.meta.dir, "../plugins/pstack/skills");
const mode = join(skills, "poteto-mode");
const script = join(mode, "scripts/open-run.mjs");

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-open-run-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(...args) {
  const result = spawnSync("node", [script, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr, stdout: result.stdout, stderr: result.stderr };
}

describe("open-run --dry-run", () => {
  test("prints the steps and the commit and PR gates", () => {
    const result = run("--dry-run", "bug-fix");
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("# bug-fix\n");
    expect(result.stdout).toContain("- [ ] Run `/deslop` over the diff before commit.");
    expect(result.stdout).toContain("- [ ] Run `/no-comments` before review.");
    expect(result.stdout).toMatch(/nothing written: \d+ steps, 3 PR gates\n$/);
  });

  test("takes a project playbook by path and writes nothing", () =>
    withDir((dir) => {
      const playbook = join(dir, "ours.md");
      writeFileSync(playbook, "---\nextends:\nwhen: Shipping.\n---\n\n1. Tag the release.\n   /tmp/todo.md: 9 steps\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(0);
      expect(result.out).toContain("- [ ] 1. Tag the release.");
      expect(result.out).toContain("nothing written: 1 steps");
      expect(readdirSync(dir)).toEqual(["ours.md"]);
    }));

  test("prints the figure-it-out phases and every bundled playbook", () => {
    const names = readdirSync(join(mode, "playbooks")).map((f) => f.replace(/\.md$/, ""));
    for (const name of ["figure-it-out", ...names]) expect(run("--dry-run", name).code).toBe(0);
  });

  test("refuses an extending project playbook and an unknown one", () =>
    withDir((dir) => {
      const playbook = join(dir, "ours.md");
      writeFileSync(playbook, "---\nextends: bug-fix\nwhen: x\n---\n");
      expect(run("--dry-run", playbook).code).toBe(2);
      expect(run("--dry-run", "no-such-playbook").code).toBe(2);
      expect(run("--dry-run").code).toBe(2);
    }));

  test("exits 2 with a usage message without --dry-run, and writes nothing", () =>
    withDir((dir) => {
      const result = run("feature", dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Usage: node open-run.mjs --dry-run");
      expect(run("--check", "todo.md").code).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
    }));
});
