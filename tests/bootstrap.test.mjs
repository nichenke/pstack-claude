import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const scripts = new URL("../plugins/pstack/skills/poteto-mode/scripts/", import.meta.url);
const commands = ["orch/orch.ts", "watch-pr/watch-pr", "watch-pr/ship-pr"];

function fingerprint(directory) {
  const hash = createHash("sha256");
  function walk(root, prefix = "") {
    for (const name of readdirSync(root).sort()) {
      const path = join(root, name);
      const relative = join(prefix, name);
      const stat = lstatSync(path);
      hash.update(`${relative}\0${stat.mode}\0`);
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) walk(path, relative);
      else hash.update(readFileSync(path));
    }
  }
  walk(directory);
  return hash.digest("hex");
}

for (const command of commands) {
  test(`${command} cold and repeated calls leave the plugin unchanged`, () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-bootstrap-"));
    try {
      const plugin = join(root, "plugin");
      cpSync(scripts, plugin, {
        recursive: true,
        filter: (source) => basename(source) !== "node_modules",
      });
      const before = fingerprint(plugin);
      const env = { ...process.env, XDG_CACHE_HOME: join(root, "cache") };
      for (let call = 0; call < 2; call++) {
        const result = Bun.spawnSync([process.execPath, join(plugin, command), "--help"], {
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.stderr.toString()).not.toContain("Cannot find package");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain("Usage:");
        expect(fingerprint(plugin)).toBe(before);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
}
