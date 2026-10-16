import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENED } from "../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";

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

  test("reads the extends line of a project playbook saved with a byte order mark", () =>
    withDir((dir) => {
      const playbook = join(dir, "our-bug-fix.md");
      writeFileSync(playbook, '\uFEFF---\r\nextends: bug-fix\r\nwhen: A bug here.\r\n---\r\n\r\n- **After** "Reproduce" add a step.\r\n');
      expect(run(playbook, join(dir, "run")).code).toBe(2);
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

describe("open-run --slug", () => {
  test("names the list and trail after the task slug, as show-me-your-work names a shared-checkout trail", () =>
    withDir((dir) => {
      const result = run("--slug", "fix-login_2", "bug-fix", dir);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`${dir}/fix-login_2.todo.md: `);
      expect(readdirSync(dir).sort()).toEqual(["fix-login_2.todo.md", "fix-login_2.tsv"]);
      const header = readFileSync(join(skills, "show-me-your-work/references/decision-log-template.tsv"), "utf8");
      expect(readFileSync(join(dir, "fix-login_2.tsv"), "utf8")).toBe(header);
      expect(readFileSync(join(dir, "fix-login_2.todo.md"), "utf8")).toContain("/deslop");
    }));

  test("takes the flag after the positionals and a one-character slug", () =>
    withDir((dir) => {
      expect(run("feature", dir, "--slug=A").code).toBe(0);
      expect(readdirSync(dir).sort()).toEqual(["A.todo.md", "A.tsv"]);
    }));

  test("two slugs in one work dir keep separate files, and a rerun leaves its own alone", () =>
    withDir((dir) => {
      run("--slug", "one", "feature", dir);
      writeFileSync(join(dir, "one.todo.md"), "mine\n");
      run("--slug", "two", "investigation", dir);
      expect(run("--slug", "one", "feature", dir).out).toContain("one.todo.md exists; left as is");
      expect(readFileSync(join(dir, "one.todo.md"), "utf8")).toBe("mine\n");
      expect(readdirSync(dir).sort()).toEqual(["one.todo.md", "one.tsv", "two.todo.md", "two.tsv"]);
    }));

  for (const slug of ["", "a/b", "..", ".", ".hidden", "a.b", "a b", "a\\b", "_lead", "-lead", "café"]) {
    test(`rejects the slug ${JSON.stringify(slug)} and writes nothing`, () =>
      withDir((dir) => {
        const work = join(dir, "run");
        expect(run(`--slug=${slug}`, "feature", work).code).toBe(2);
        expect(existsSync(work)).toBe(false);
      }));
  }

  test("rejects a missing slug value and an unknown flag", () =>
    withDir((dir) => {
      expect(run("feature", dir, "--slug").code).toBe(2);
      expect(run("--slg", "x", "feature", dir).code).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
    }));
});

describe("open-run --dry-run", () => {
  test("prints the list a run would open and writes nothing", () =>
    withDir((dir) => {
      const work = join(dir, "run");
      const result = spawnSync("node", [script, "--dry-run", "bug-fix", work], { cwd: dir, encoding: "utf8" });
      expect(result.status).toBe(0);
      run("bug-fix", join(dir, "real"));
      expect(result.stdout).toStartWith(readFileSync(join(dir, "real/todo.md"), "utf8"));
      expect(result.stdout).toContain("- [ ] Run `/no-comments` before review.");
      expect(result.stdout).toMatch(/nothing written: \d+ steps, 3 PR gates\n$/);
      expect(existsSync(work)).toBe(false);
      expect(readdirSync(dir)).toEqual(["real"]);
    }));

  test("needs no work dir, and takes a project playbook by path", () =>
    withDir((dir) => {
      const playbook = join(dir, "todo.md");
      writeFileSync(playbook, "---\nextends:\nwhen: Shipping.\n---\n\n1. Tag the release.\n   /tmp/todo.md: 9 steps\n");
      const result = run("--dry-run", playbook);
      expect(result.code).toBe(0);
      expect(result.out).toContain("- [ ] 1. Tag the release.");
      expect(result.out).toContain("nothing written: 1 steps");
      expect([...result.out.matchAll(OPENED)]).toEqual([]);
      expect(readdirSync(dir)).toEqual(["todo.md"]);
    }));

  test("prints no line the Stop hook reads as an opened list, for any playbook", () =>
    withDir((dir) => {
      const names = readdirSync(join(mode, "playbooks")).map((f) => f.replace(/\.md$/, ""));
      for (const name of ["figure-it-out", ...names]) {
        const result = run("--dry-run", "--slug", "t", name, dir);
        expect(result.code).toBe(0);
        expect([...result.out.matchAll(OPENED)]).toEqual([]);
      }
      expect(readdirSync(dir)).toEqual([]);
    }));

  test("still refuses an extending project playbook, an unknown one, a bad slug, and --check", () =>
    withDir((dir) => {
      const playbook = join(dir, "ours.md");
      writeFileSync(playbook, "---\nextends: bug-fix\nwhen: x\n---\n");
      expect(run("--dry-run", playbook).code).toBe(2);
      expect(run("--dry-run", "no-such-playbook").code).toBe(2);
      expect(run("--dry-run", "--slug", "a/b", "feature").code).toBe(2);
      expect(run("--dry-run", "--check", playbook).code).toBe(2);
      expect(run("--dry-run").code).toBe(2);
      expect(readdirSync(dir)).toEqual(["ours.md"]);
    }));
});

describe("open-run --check", () => {
  test("checks a slug-named list the same way", () =>
    withDir((dir) => {
      run("--slug", "t", "feature", dir);
      const result = run("--check", join(dir, "t.todo.md"));
      expect(result.code).toBe(1);
      expect(result.out).toContain(`${join(dir, "t.todo.md")}:`);
      writeFileSync(join(dir, "t.todo.md"), "- [x] 1. done\n");
      expect(run("--check", join(dir, "t.todo.md")).code).toBe(0);
    }));

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

  test("a BLOCKED: line with a reason is resolved, on its own box or appended to a step", () =>
    withDir((dir) => {
      const file = join(dir, "todo.md");
      writeFileSync(file, "- [ ] BLOCKED: independent review\n- [ ] 5. Review the diff. BLOCKED: independent review, no reviewer can run\n");
      expect(run("--check", file)).toEqual({ code: 0, out: expect.stringContaining("0 open") });
    }));

  test("a bare, placeholder, lowercase or run-on BLOCKED does not count", () =>
    withDir((dir) => {
      const file = join(dir, "todo.md");
      const lines = ["- [ ] BLOCKED:", "- [ ] 5. Review. BLOCKED:   ", "- [ ] BLOCKED: <reason>", "- [ ] blocked: no reviewer", "- [ ] UNBLOCKED: now"];
      writeFileSync(file, lines.join("\n") + "\n");
      expect(run("--check", file).out).toContain(`${lines.length} open`);
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
