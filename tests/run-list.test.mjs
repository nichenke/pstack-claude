import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSession, OPENED, ownedList, RUN_FILE, sessionHeader, TODO_FILE, trailBeside } from "../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";

const opened = (text) => [...text.matchAll(OPENED)].map((m) => m[1]);

describe("OPENED", () => {
  test("captures a written or found list, plain or slug-named", () => {
    expect(
      opened(
        [
          "/s/todo.md: 6 steps, 3 PR gates",
          "/s/decisions.tsv: started",
          "/repo/.audit/fix-login_2.todo.md: 8 steps",
          "/repo/.audit/fix-login_2.tsv: started",
          "/my run/todo.md exists; left as is",
        ].join("\n"),
      ),
    ).toEqual(["/s/todo.md", "/repo/.audit/fix-login_2.todo.md", "/my run/todo.md"]);
  });

  test("captures drive-letter and UNC paths as open-run prints them on Windows", () => {
    expect(
      opened(
        [
          "C:\\Users\\me\\AppData\\Local\\Temp\\run\\todo.md: 6 steps, 3 PR gates",
          "d:/work/.audit/t.todo.md exists; left as is",
          "\\\\server\\share\\run\\t.todo.md: 1 steps",
        ].join("\r\n"),
      ),
    ).toEqual([
      "C:\\Users\\me\\AppData\\Local\\Temp\\run\\todo.md",
      "d:/work/.audit/t.todo.md",
      "\\\\server\\share\\run\\t.todo.md",
    ]);
  });

  test("passes over names that are not a run's list, relative paths, and other output", () => {
    expect(
      opened(
        [
          "/s/mytodo.md: 1 steps",
          "/s/a.b.todo.md: 1 steps",
          "/s/.todo.md: 1 steps",
          "/s/-x.todo.md: 1 steps",
          "run/todo.md: 1 steps",
          "C:todo.md: 1 steps",
          "/s/todo.md:3: 1. open step",
          "/s/todo.md: started",
          "  /s/todo.md: 1 steps",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("run file names", () => {
  test("TODO_FILE and RUN_FILE take the plain and slug names only", () => {
    for (const file of ["/s/todo.md", "C:\\s\\t.todo.md", "todo.md"]) expect(TODO_FILE.test(file)).toBe(true);
    for (const file of ["/s/mytodo.md", "/s/a.b.todo.md", "/s/todo.md.bak"]) expect(TODO_FILE.test(file)).toBe(false);
    for (const file of ["/s/decisions.tsv", "/s/t.tsv", "/s/t.todo.md"]) expect(RUN_FILE.test(file)).toBe(true);
    for (const file of ["/s/a.py", "/s/.tsv", "/s/a.b.tsv"]) expect(RUN_FILE.test(file)).toBe(false);
  });

  test("trailBeside pairs each list with the trail open-run wrote beside it", () => {
    expect(trailBeside("/s/todo.md")).toBe("/s/decisions.tsv");
    expect(trailBeside("/repo/.audit/fix-1.todo.md")).toBe("/repo/.audit/fix-1.tsv");
  });
});

describe("list ownership", () => {
  test("listSession reads the Session: line open-run writes, from the header block only", () => {
    const header = ["# bug-fix", "", "Steps copied from poteto-mode/playbooks/bug-fix.md.", "", sessionHeader("s-1"), ""];
    expect(listSession([...header, "- [ ] 1. open"].join("\n"))).toBe("s-1");
    expect(listSession([...header.slice(0, 3), "", "- [ ] 1. open"].join("\r\n"))).toBe(null);
    expect(listSession("# x\n\n- [ ] 1. step\nSession: s-1\n")).toBe(null);
    expect(listSession("# x\n\n- [ ] Session: s-1\n")).toBe(null);
    expect(listSession("Session: \n- [ ] 1. open\n")).toBe(null);
    expect(listSession("Session: s 1\n")).toBe(null);
    expect(listSession("")).toBe(null);
  });

  test("ownedList walks back from the latest list to the first this session owns", () => {
    const lists = { "/a/todo.md": "Session: s1\n", "/b/todo.md": "Session: s2\n", "/c/todo.md": "# none\n" };
    const read = (file) => lists[file] ?? null;
    expect(ownedList(["/a/todo.md"], "s1", read)).toBe("/a/todo.md");
    expect(ownedList(["/a/todo.md", "/b/todo.md", "/c/todo.md"], "s1", read)).toBe("/a/todo.md");
    expect(ownedList(["/b/todo.md", "/a/todo.md", "/b/todo.md"], "s1", read)).toBe("/a/todo.md");
    expect(ownedList(["/a/todo.md", "/b/todo.md"], "s2", read)).toBe("/b/todo.md");
    expect(ownedList(["/b/todo.md", "/c/todo.md"], "s1", read)).toBe(null);
    expect(ownedList([], "s1", read)).toBe(null);
  });

  test("ownedList stops at a missing list rather than reviving one it superseded", () => {
    const read = (file) => (file === "/a/todo.md" ? "Session: s1\n" : null);
    expect(ownedList(["/a/todo.md", "/gone/todo.md"], "s1", read)).toBe(null);
  });

  test("ownedList owns nothing for a session with no id, unmarked lists included", () => {
    const read = () => "# none\n";
    for (const session of [undefined, null, ""]) expect(ownedList(["/c/todo.md"], session, read)).toBe(null);
  });

  test("ownedList reads the disk by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "pstack-run-list-"));
    try {
      writeFileSync(join(dir, "todo.md"), `# x\n\n${sessionHeader("s1")}\n\n- [ ] 1. open\n`);
      expect(ownedList([join(dir, "todo.md")], "s1")).toBe(join(dir, "todo.md"));
      expect(ownedList([join(dir, "todo.md")], "s2")).toBe(null);
      expect(ownedList([join(dir, "todo.md"), join(dir, "gone/todo.md")], "s1")).toBe(null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
