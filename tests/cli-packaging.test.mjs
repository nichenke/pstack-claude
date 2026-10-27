import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginLayout } from "../tools/generate.mjs";

const pluginSource = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const fixtures = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pstack-cli-package-"));
  fixtures.push(root);
  return root;
}
function permissions(root, directory, file) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) permissions(path, directory, file);
    else if (!entry.isSymbolicLink()) chmodSync(path, file);
  }
  chmodSync(root, directory);
}
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    permissions(root, 0o755, 0o644);
    rmSync(root, { recursive: true, force: true });
  }
});
function inventory(root, prefix = "") {
  return readdirSync(root).sort().flatMap((name) => {
    const relative = join(prefix, name);
    const path = join(root, name);
    const stat = lstatSync(path);
    return stat.isDirectory()
      ? [[relative, stat.mode], ...inventory(path, relative)]
      : [[relative, stat.mode, createHash("sha256").update(readFileSync(path)).digest("hex")]];
  });
}

describe("immutable plugin packaging", () => {
  test.each(["node_modules", "skills/nested/node_modules"])("rejects %s even when empty", (relative) => {
    const root = fixture();
    mkdirSync(join(root, "skills"));
    mkdirSync(join(root, relative), { recursive: true });
    expect(() => validatePluginLayout(root)).toThrow(/node_modules/);
  });

  test.each(["file", "directory", "dangling"])("rejects a %s symlink", (kind) => {
    const root = fixture();
    mkdirSync(join(root, "skills"));
    const target = join(fixture(), "target");
    if (kind === "file") writeFileSync(target, "fixture");
    if (kind === "directory") mkdirSync(target);
    symlinkSync(target, join(root, "linked"), kind === "directory" ? "dir" : "file");
    expect(() => validatePluginLayout(root)).toThrow(/symlink/);
  });

  test("installed commands work without dependencies and leave a read-only plugin unchanged", () => {
    const root = fixture();
    const plugin = join(root, "plugin");
    cpSync(pluginSource, plugin, { recursive: true });
    permissions(plugin, 0o555, 0o444);
    const before = inventory(plugin);
    const scripts = join(plugin, "skills/poteto-mode/scripts");
    const env = { ...process.env, HOME: root, BUN_INSTALL_CACHE_DIR: join(root, "empty-cache"), npm_config_registry: "http://127.0.0.1:1", ORCH_STORE: join(root, "store") };
    const run = (entry, args) => spawnSync(process.execPath, ["run", join(scripts, entry), ...args], {
      cwd: root, env, encoding: "utf8", timeout: 5000,
    });
    for (const [entry, name, usageExit] of [["orch/orch.ts", "orch", 1], ["watch-pr/watch-pr", "watch-pr", 64], ["watch-pr/ship-pr", "ship-pr", 64]]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const help = run(entry, ["--help"]);
        expect(help.status, help.stderr).toBe(0);
        expect(help.stdout).toContain(`Usage: ${name}`);
      }
      const invalid = run(entry, ["--unknown-packaging-option"]);
      expect(invalid.status, invalid.stderr).toBe(usageExit);
      expect(invalid.stderr).toContain("unknown option");
    }
    const initialized = run("orch/orch.ts", ["init"]);
    expect(initialized.status, initialized.stderr).toBe(0);
    const added = run("orch/orch.ts", ["unit", "add", "example", "--track", "build", "--json"]);
    expect(added.status, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ id: "example", track: "build", state: "pending" });
    expect(inventory(plugin)).toEqual(before);
  });
});
