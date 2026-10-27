import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apply, changes, OUTPUT, plan } from "../tools/build-cli.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const fixtures = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-build-cli-"));
  fixtures.push(root);
  return root;
};
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("build checks find stale, missing and orphaned runtime files without writing", async () => {
  const files = await plan(repo);
  const root = fixture();
  apply(root, files);
  expect(changes(root, files)).toEqual({ write: [], remove: [] });
  const [stale, missing] = [...files.keys()];
  writeFileSync(join(root, stale), "stale fixture\n");
  unlinkSync(join(root, missing));
  const orphan = `${OUTPUT}/old-runtime.mjs`;
  writeFileSync(join(root, orphan), "unrelated previous artifact\n");
  expect(changes(root, files)).toEqual({ write: [stale, missing], remove: [orphan] });
  expect(readFileSync(join(root, stale), "utf8")).toBe("stale fixture\n");
  expect(readFileSync(join(root, orphan), "utf8")).toBe("unrelated previous artifact\n");
  apply(root, files);
  expect(changes(root, files)).toEqual({ write: [], remove: [] });
});

test("unresolved source conflicts cannot disappear into generated bundles", async () => {
  const root = fixture();
  mkdirSync(join(root, "tools/cli"), { recursive: true });
  writeFileSync(join(root, "tools/cli/unresolved.ts"), "<<<<<<< local\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> upstream\n");
  await expect(plan(root)).rejects.toThrow(/unresolved.ts:1: unresolved sync conflict/);
});

test.each(["parent", "orphan"])("apply refuses a generated %s symlink before changing files", (kind) => {
  const root = fixture();
  const outside = fixture();
  const sentinel = join(outside, "sentinel.mjs");
  writeFileSync(sentinel, "preserve this external file\n");
  mkdirSync(join(root, OUTPUT, ".."), { recursive: true });
  if (kind === "parent") symlinkSync(outside, join(root, OUTPUT), "dir");
  else {
    mkdirSync(join(root, OUTPUT));
    symlinkSync(sentinel, join(root, OUTPUT, "orphan.mjs"));
  }
  const files = new Map([[`${OUTPUT}/sentinel.mjs`, { content: Buffer.from("generated\n"), mode: 0o755 }]]);
  expect(() => apply(root, files)).toThrow(/generated symlinks are unsupported/);
  expect(readFileSync(sentinel, "utf8")).toBe("preserve this external file\n");
});
