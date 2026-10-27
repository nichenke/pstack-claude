#!/usr/bin/env bun
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BUN_VERSION = "1.3.14";
export const OUTPUT = "plugins/pstack/skills/poteto-mode/scripts";
const SOURCE = "tools/cli";
const ENTRIES = ["orch/orch.ts", "watch-pr/watch-pr", "watch-pr/ship-pr"];

function paths(root, relative = "", skipModules = false) {
  const directory = join(root, relative);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (skipModules && entry.name === "node_modules") return [];
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? paths(root, path, skipModules) : [path];
  });
}

export async function plan(root) {
  if (typeof Bun === "undefined" || Bun.version !== BUN_VERSION) {
    throw new Error(`CLI bundles require Bun ${BUN_VERSION}; use the version pinned in CI`);
  }
  const source = join(root, SOURCE);
  for (const path of paths(source, "", true)) {
    const absolute = join(source, path);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${SOURCE}/${path}: source symlinks are unsupported`);
    const lines = readFileSync(absolute, "utf8").split("\n");
    const index = lines.findIndex((line) => /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/.test(line));
    if (index >= 0) throw new Error(`${SOURCE}/${path}:${index + 1}: unresolved sync conflict`);
  }
  const files = new Map();
  for (const name of readdirSync(source).filter((name) => name.endsWith(".mjs")).sort()) {
    const path = join(source, name);
    files.set(`${OUTPUT}/${name}`, { content: readFileSync(path), mode: statSync(path).mode & 0o777 });
  }
  const license = readFileSync(join(source, "node_modules/commander/LICENSE"), "utf8");
  for (const entry of ENTRIES) {
    const result = await Bun.build({
      entrypoints: [join(source, entry)],
      root: source,
      target: "bun",
      format: "esm",
      packages: "bundle",
      minify: true,
      sourcemap: "none",
      splitting: false,
      write: false,
      banner: `/*\n${license.trim()}\n*/`,
      plugins: [{
        name: "extensionless-cli",
        setup(build) {
          build.onLoad({ filter: /[/\\](?:watch-pr|ship-pr)$/ }, ({ path }) => ({
            contents: readFileSync(path, "utf8"),
            loader: "js",
          }));
        },
      }],
    });
    if (!result.success) throw new AggregateError(result.logs, `Could not bundle ${SOURCE}/${entry}`);
    if (result.outputs.length !== 1) throw new Error(`${SOURCE}/${entry}: expected one bundle`);
    files.set(`${OUTPUT}/${entry}`, {
      content: Buffer.from(await result.outputs[0].arrayBuffer()),
      mode: 0o755,
    });
  }
  return files;
}

export function changes(root, files) {
  const existing = paths(join(root, OUTPUT)).map((path) => `${OUTPUT}/${path}`);
  const directories = new Set([...files.keys()].flatMap((path) => {
    const parts = path.split("/");
    return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
  }));
  for (const path of [...directories, ...existing]) {
    try {
      if (lstatSync(join(root, path)).isSymbolicLink()) throw new Error(`${path}: generated symlinks are unsupported`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const write = [...files].flatMap(([path, expected]) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return [path];
    const stat = lstatSync(absolute);
    return !stat.isFile() || (stat.mode & 0o777) !== expected.mode || !readFileSync(absolute).equals(expected.content) ? [path] : [];
  });
  const remove = existing.filter((path) => !files.has(path));
  return { write, remove };
}

export function apply(root, files) {
  const pending = changes(root, files);
  for (const path of pending.remove) rmSync(join(root, path), { recursive: true, force: true });
  for (const path of pending.write) {
    const absolute = join(root, path);
    const { content, mode } = files.get(path);
    if (existsSync(absolute)) rmSync(absolute, { recursive: true, force: true });
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, { mode });
    chmodSync(absolute, mode);
  }
  return pending;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("usage: bun tools/build-cli.mjs [--check]");
    process.exitCode = 2;
  } else {
    try {
      const root = join(dirname(fileURLToPath(import.meta.url)), "..");
      const files = await plan(root);
      const pending = args[0] === "--check" ? changes(root, files) : apply(root, files);
      for (const path of pending.write) console.log(`write ${path}`);
      for (const path of pending.remove) console.log(`remove ${path}`);
      if (args[0] === "--check" && (pending.write.length || pending.remove.length)) process.exitCode = 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
