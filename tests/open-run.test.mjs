import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return { code: result.status, out: result.stdout + result.stderr };
}

function boxes(todo) {
  return todo.split("\n").filter((line) => line.startsWith("- [ ] "));
}

describe("open-run", () => {
  test("copies every numbered step of the playbook verbatim", () =>
    withDir((dir) => {
      expect(run("feature", dir).code).toBe(0);
      const todo = readFileSync(join(dir, "todo.md"), "utf8");
      const playbook = readFileSync(join(mode, "playbooks/feature.md"), "utf8");
      const steps = playbook.split("\n").filter((line) => /^\d+\. /.test(line));
      expect(steps.length).toBe(8);
      for (const step of steps) expect(todo).toContain(`- [ ] ${step}`);
    }));

  test("keeps a step's continuation lines with it", () =>
    withDir((dir) => {
      run("feature", dir);
      const todo = readFileSync(join(dir, "todo.md"), "utf8");
      expect(todo).toContain("   - **Blocking first steps.** Gates run before fan-out.");
    }));

  test("skips numbered lines inside fenced blocks", () =>
    withDir((dir) => {
      run("multi-phase-plan", dir);
      const todo = readFileSync(join(dir, "todo.md"), "utf8");
      const playbook = readFileSync(join(mode, "playbooks/multi-phase-plan.md"), "utf8");
      const outside = playbook.replace(/^(`{3,})[\s\S]*?^\1$/gm, "");
      const steps = outside.split("\n").filter((line) => /^\d+\. /.test(line));
      expect(boxes(todo).filter((b) => /^- \[ \] \d+\. /.test(b)).length).toBe(steps.length);
    }));

  test("adds the commit and PR gates to a playbook that ends in Opening a PR", () =>
    withDir((dir) => {
      run("bug-fix", dir);
      const todo = readFileSync(join(dir, "todo.md"), "utf8");
      expect(todo).toContain("Run `/deslop` over the diff before commit.");
      expect(todo).toContain("Run `/no-comments` before review.");
      expect(todo).toContain("skip: <the user or harness rule that blocks it>");
    }));

  test("opening-a-pr alone, which has no numbered steps, still gets the PR gates", () =>
    withDir((dir) => {
      run("opening-a-pr", dir);
      expect(boxes(readFileSync(join(dir, "todo.md"), "utf8")).length).toBe(3);
    }));

  test("leaves the PR gates off a read-only playbook", () =>
    withDir((dir) => {
      run("investigation", dir);
      expect(readFileSync(join(dir, "todo.md"), "utf8")).not.toContain("/deslop");
    }));

  test("opens figure-it-out with its phases and the PR gates", () =>
    withDir((dir) => {
      expect(run("figure-it-out", dir).code).toBe(0);
      const todo = readFileSync(join(dir, "todo.md"), "utf8");
      for (const phase of ["Phase A: Frame", "Phase B: Design the workflow", "Phase E: Verify and hand back"])
        expect(todo).toContain(phase);
      expect(todo).toContain("/no-comments");
    }));

  test("starts the decision trail with show-me-your-work's header", () =>
    withDir((dir) => {
      run("feature", dir);
      const header = readFileSync(join(skills, "show-me-your-work/references/decision-log-template.tsv"), "utf8");
      expect(readFileSync(join(dir, "decisions.tsv"), "utf8")).toBe(header);
    }));

  test("rerunning leaves an existing todolist and trail alone", () =>
    withDir((dir) => {
      writeFileSync(join(dir, "todo.md"), "mine\n");
      writeFileSync(join(dir, "decisions.tsv"), "rows\n");
      expect(run("feature", dir).code).toBe(0);
      expect(readFileSync(join(dir, "todo.md"), "utf8")).toBe("mine\n");
      expect(readFileSync(join(dir, "decisions.tsv"), "utf8")).toBe("rows\n");
    }));

  test("prints the list's absolute path, which the Stop hook reads back", () =>
    withDir((dir) => {
      const result = spawnSync("node", [script, "feature", "run"], { cwd: dir, encoding: "utf8" });
      expect(result.stdout).toMatch(new RegExp(`^/\\S*/run/todo\\.md: 8 steps`, "m"));
    }));

  test("opens a standalone project playbook by its path", () =>
    withDir((dir) => {
      const playbook = join(dir, "deploy.md");
      writeFileSync(
        playbook,
        "---\nextends:\nwhen: Shipping a release.\n---\n\n1. Tag the release.\n2. Run **Opening a PR**.\n",
      );
      const work = join(dir, "run");
      expect(run(playbook, work).code).toBe(0);
      const todo = readFileSync(join(work, "todo.md"), "utf8");
      expect(todo.split("\n")[0]).toBe("# deploy");
      expect(boxes(todo).slice(0, 2)).toEqual(["- [ ] 1. Tag the release.", "- [ ] 2. Run **Opening a PR**."]);
      expect(todo).toContain("/deslop");
    }));

  test("rejects a project playbook that extends a bundled one and names the base", () =>
    withDir((dir) => {
      const playbook = join(dir, "our-bug-fix.md");
      writeFileSync(playbook, '---\nextends: bug-fix\nwhen: A bug here.\n---\n\n- **After** "Reproduce" add a step.\n');
      const result = run(playbook, join(dir, "run"));
      expect(result.code).toBe(2);
      expect(result.out).toContain("bug-fix");
      expect(existsSync(join(dir, "run/todo.md"))).toBe(false);
    }));

  test("rejects a playbook path that does not exist and writes nothing", () =>
    withDir((dir) => {
      expect(run(join(dir, "missing.md"), dir).code).toBe(2);
      expect(existsSync(join(dir, "todo.md"))).toBe(false);
    }));

  test("rejects an unknown playbook and writes nothing", () =>
    withDir((dir) => {
      const result = run("no-such-playbook", dir);
      expect(result.code).toBe(2);
      expect(result.out).toContain("feature");
      expect(existsSync(join(dir, "todo.md"))).toBe(false);
    }));
});

describe("open-run --check", () => {
  test("fails on an open step and names its line", () =>
    withDir((dir) => {
      run("feature", dir);
      const result = run("--check", join(dir, "todo.md"));
      expect(result.code).toBe(1);
      expect(result.out).toContain("todo.md:");
      expect(result.out).toContain("1. `how` over the affected subsystem.");
    }));

  test("passes when every step is done or carries a skip or n/a reason", () =>
    withDir((dir) => {
      const file = join(dir, "todo.md");
      writeFileSync(file, "- [x] 1. done\n- [ ] 2. dropped skip: no UI surface\n- [ ] 3. n/a: single file\n");
      expect(run("--check", file)).toEqual({ code: 0, out: expect.stringContaining("0 open") });
    }));

  test("an empty skip reason does not count", () =>
    withDir((dir) => {
      const file = join(dir, "todo.md");
      writeFileSync(file, "- [ ] 1. dropped skip:\n");
      expect(run("--check", file).code).toBe(1);
    }));

  test("every box of every fresh list is open, the PR gate's skip template included", () =>
    withDir((dir) => {
      const names = readdirSync(join(mode, "playbooks")).map((f) => f.replace(/\.md$/, ""));
      for (const name of ["figure-it-out", ...names]) {
        run(name, join(dir, name));
        const todo = join(dir, name, "todo.md");
        expect(run("--check", todo).out).toContain(`\n${boxes(readFileSync(todo, "utf8")).length} open`);
      }
      expect(run("--check", join(dir, "bug-fix/todo.md")).out).toContain("Run **Opening a PR**, or keep this line");
    }));

  test("a placeholder skip reason does not count", () =>
    withDir((dir) => {
      const file = join(dir, "todo.md");
      writeFileSync(file, "- [ ] 1. dropped skip: <reason>\n- [ ] 2. dropped `skip: <the rule>`\n");
      expect(run("--check", file).out).toContain("2 open");
    }));
});
