import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// This tooling is bun-only (import.meta.dir, Bun.spawnSync, bun.lock). Fail with a
// clear message instead of an opaque `import.meta.dir is undefined` crash under node.
if (typeof Bun === "undefined") {
  console.error(
    "pstack poteto-mode tooling requires bun (https://bun.sh). Install bun, then re-run."
  );
  process.exit(1);
}

const scriptsDirectory = import.meta.dir;
const cacheDirectory = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "pstack",
  "poteto-mode-tools"
);

export async function loadCommander(): Promise<typeof import("commander")> {
  const packageJson = readFileSync(join(scriptsDirectory, "package.json"));
  const lockfile = readFileSync(join(scriptsDirectory, "bun.lock"));
  const installKey = createHash("sha256")
    .update(packageJson)
    .update("\0")
    .update(lockfile)
    .digest("hex");
  const installDirectory = join(cacheDirectory, installKey);
  const commanderEntry = join("node_modules", "commander", "esm.mjs");
  const commanderPath = join(installDirectory, commanderEntry);
  if (!existsSync(commanderPath)) {
    mkdirSync(cacheDirectory, { recursive: true });
    const stagingDirectory = mkdtempSync(join(cacheDirectory, ".staging-"));
    try {
      writeFileSync(join(stagingDirectory, "package.json"), packageJson);
      writeFileSync(join(stagingDirectory, "bun.lock"), lockfile);
      const result = Bun.spawnSync(
        [process.execPath, "install", "--frozen-lockfile", "--production"],
        { cwd: stagingDirectory }
      );
      if (result.exitCode !== 0) {
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        throw new Error(
          `bun install --frozen-lockfile exited with status ${result.exitCode}`
        );
      }
      if (!existsSync(join(stagingDirectory, commanderEntry))) {
        throw new Error(
          "bun install --frozen-lockfile completed without installing commander"
        );
      }
      try {
        renameSync(stagingDirectory, installDirectory);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") ||
          !existsSync(commanderPath)
        ) {
          throw error;
        }
      }
    } finally {
      rmSync(stagingDirectory, { recursive: true, force: true });
    }
  }

  return import(pathToFileURL(commanderPath).href);
}
