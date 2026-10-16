import { describe, expect, test } from "bun:test";
import { OPENED, RUN_FILE, TODO_FILE, trailBeside } from "../plugins/pstack/skills/poteto-mode/scripts/run-list.mjs";

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
