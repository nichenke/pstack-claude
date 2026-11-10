import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
      writeFileSync(playbook, "---\nextends:\nwhen: Shipping.\n---\n\n1. Tag the release.\n");
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

  test("keeps a step's indented lines directly under its - [ ] line", () => {
    const { stdout } = run("--dry-run", "feature");
    const lines = stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith("- [ ] 3. "));
    expect(lines.slice(at + 1, at + 5)).toEqual([
      expect.stringMatching(/^ {3}- \*\*Blocking first steps\.\*\* /),
      expect.stringMatching(/^ {3}- \*\*Independent workstreams\.\*\* /),
      expect.stringMatching(/^ {3}- \*\*Shared mutable state\.\*\* /),
      expect.stringMatching(/^ {3}- \*\*Smallest safe decomposition\.\*\* /),
    ]);
    expect(lines[at + 5]).toStartWith("- [ ] 4. ");
  });

  test("does not turn numbered lines inside fences into tasks", () =>
    withDir((dir) => {
      const playbook = join(dir, "fenced.md");
      writeFileSync(
        playbook,
        "1. Real one.\n\n```text\n7. Inside a backtick fence.\n```\n\n~~~\n8. Inside a tilde fence.\n~~~\n\n````md\n```\n9. Inside a longer fence.\n```\n````\n\n2. Second real one.\n",
      );
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("- [ ] 1. Real one.\n- [ ] 2. Second real one.\n");
      expect(result.stdout).not.toMatch(/Inside a/);
      expect(result.stdout).toContain("nothing written: 2 steps\n");
    }));

  test("adds the PR gates after a playbook that names Opening a PR, and only then", () => {
    for (const name of ["bug-fix", "feature", "opening-a-pr", "figure-it-out"]) {
      const { stdout } = run("--dry-run", name);
      expect(stdout).toContain("\n## Commit and PR gates\n");
      expect(stdout).toMatch(/, 3 PR gates\n$/);
    }
  });

  test("gives opening-a-pr, which has no numbered steps, the gates and no placeholder", () => {
    const { stdout } = run("--dry-run", "opening-a-pr");
    expect(stdout).toContain("nothing written: 0 steps, 3 PR gates\n");
    expect(stdout).not.toContain("has no numbered steps");
    expect(stdout).not.toContain("to write");
  });

  test("leaves the PR gates off a project playbook that does not ship code", () =>
    withDir((dir) => {
      const playbook = join(dir, "triage.md");
      writeFileSync(playbook, "1. Read the alert.\n2. Page the owner.\n");
      const { code, stdout } = run("--dry-run", playbook);
      expect(code).toBe(0);
      expect(stdout).not.toContain("Commit and PR gates");
      expect(stdout).not.toContain("/deslop");
      expect(stdout).toEndWith("nothing written: 2 steps\n");
    }));

  test("prints the placeholder step and ', 1 to write' for a playbook with no numbered steps", () =>
    withDir((dir) => {
      const rulesOnly = join(dir, "rules-only.md");
      writeFileSync(rulesOnly, "### Rules only\n\n- **One owner per PR.** Only the owner pushes.\n");
      for (const arg of ["orchestrate", rulesOnly]) {
        const { code, stdout } = run("--dry-run", arg);
        const name = arg.endsWith(".md") ? "rules-only" : arg;
        expect(code).toBe(0);
        expect(stdout).toContain("- [ ] " + name + " has no numbered steps. Replace this line with the run's own steps.\n");
        expect(stdout).toEndWith("nothing written: 0 steps, 1 to write\n");
        expect(stdout).not.toContain("PR gates");
      }
    }));

  test("prints the figure-it-out phases and the PR gates", () => {
    const { code, stdout } = run("--dry-run", "figure-it-out");
    expect(code).toBe(0);
    for (const phase of ["Phase A: Frame", "Phase B: Design the workflow", "Phase E: Verify and hand back"])
      expect(stdout).toContain("- [ ] " + phase);
    expect(stdout).toContain("/no-comments");
  });

  test("refuses an extending project playbook, names the base, and says to open the bundled one by name", () =>
    withDir((dir) => {
      const playbook = join(dir, "ours.md");
      writeFileSync(playbook, "---\nextends: bug-fix\nwhen: x\n---\n\n- **After** Reproduce add a step.\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(playbook + " extends bug-fix.");
      expect(result.stderr).toContain("Open the bundled playbook by name");
    }));

  test("refuses a comma-separated extends and names every base", () =>
    withDir((dir) => {
      const playbook = join(dir, "ours.md");
      writeFileSync(playbook, "---\nextends: bug-fix, feature\nwhen: x\n---\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("extends bug-fix, feature.");
    }));

  test("refuses an extending playbook saved with a byte order mark and CRLF", () =>
    withDir((dir) => {
      const playbook = join(dir, "ours.md");
      writeFileSync(playbook, "﻿---\r\nextends: bug-fix\r\nwhen: x\r\n---\r\n\r\n1. A step.\r\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("extends bug-fix.");
    }));

  test("takes a standalone playbook saved with a byte order mark and CRLF", () =>
    withDir((dir) => {
      const playbook = join(dir, "crlf.md");
      writeFileSync(playbook, "﻿---\r\nextends:\r\nwhen: x\r\n---\r\n\r\n1. A step.\r\n   Detail.\r\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("- [ ] 1. A step.\n   Detail.\n");
      expect(result.stdout).not.toContain("\r");
    }));

  test("does not attach an indented line after prose to the step before it", () =>
    withDir((dir) => {
      const playbook = join(dir, "crash.md");
      writeFileSync(playbook, "1. Do it.\nSome prose.\n    indented code\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("- [ ] 1. Do it.\n");
      expect(result.stdout).not.toContain("indented code");
      expect(result.stdout).toEndWith("nothing written: 1 steps\n");
    }));

  test("exits 2 and names the path for a directory called x.md", () =>
    withDir((dir) => {
      const folder = join(dir, "x.md");
      mkdirSync(folder);
      const result = run("--dry-run", folder);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(folder);
    }));

  test("exits 2 and names the argument for a missing .md path and an unknown name", () =>
    withDir((dir) => {
      const missing = join(dir, "missing.md");
      const path = run("--dry-run", missing);
      expect(path.code).toBe(2);
      expect(path.stderr).toContain("no playbook file at " + missing);
      const name = run("--dry-run", "no-such-playbook");
      expect(name.code).toBe(2);
      expect(name.stderr).toContain("no playbook named no-such-playbook");
      expect(readdirSync(dir)).toEqual([]);
    }));

  test("names an unknown option in its refusal", () => {
    const result = run("--dry-run", "--slug", "x", "bug-fix");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("open-run: ");
    expect(result.stderr).toContain("--slug");
  });

  test("words the PR gate for a task that is marked completed", () => {
    const { stdout } = run("--dry-run", "bug-fix");
    expect(stdout).toContain(
      "- [ ] Run **Opening a PR**, or mark this completed with `skip: <the user or harness rule that blocks it>`.",
    );
    expect(stdout).not.toContain("keep this line");
  });

  test("names what is wrong without --dry-run and with the wrong argument count", () => {
    expect(run("bug-fix").stderr).toContain("open-run: --dry-run is required");
    expect(run("--dry-run").stderr).toContain("open-run: expected one playbook argument, got 0");
    expect(run("--dry-run", "bug-fix", "extra").stderr).toContain("open-run: expected one playbook argument, got 2");
  });

  test("exits 2 on a missing playbook argument and on an extra positional", () => {
    expect(run("--dry-run").code).toBe(2);
    const extra = run("--dry-run", "bug-fix", "extra");
    expect(extra.code).toBe(2);
    expect(extra.stdout).toBe("");
    expect(extra.stderr).toContain("Usage: node open-run.mjs --dry-run");
  });

  test("exits 2 with a usage message without --dry-run, and writes nothing", () =>
    withDir((dir) => {
      const result = run("feature", dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Usage: node open-run.mjs --dry-run");
      expect(run("--check", "todo.md").code).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
    }));
});
