#!/usr/bin/env node
// Registers run-gate.mjs as a Codex Stop hook in a plugin tree, by copying the Stop entry that
// hooks/hooks.json registers for Claude Code into hooks/codex-hooks.json.
// Usage: codex-stop.mjs <plugin-root>          add it (the todo-hook arm)
//        codex-stop.mjs --absent <plugin-root> only check codex-hooks.json registers no Stop hook
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const fail = (message) => {
  console.error(`codex-stop: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const absent = args[0] === "--absent";
const root = (absent ? args[1] : args[0]) ?? fail("usage: codex-stop.mjs [--absent] <plugin-root>");
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "hooks", file), "utf8"));
  } catch (error) {
    return fail(`cannot read ${path.join(root, "hooks", file)}: ${error.message}`);
  }
};

const codexFile = path.join(root, "hooks/codex-hooks.json");
const codex = read("codex-hooks.json");
if (codex.hooks?.Stop) fail(`${codexFile} already registers a Stop hook`);
if (absent) process.exit(0);

const gates = (read("hooks.json").hooks?.Stop ?? []).filter((entry) =>
  entry.hooks?.some((hook) => String(hook.command).includes("hooks/run-gate.mjs")),
);
if (gates.length !== 1) fail(`expected one Stop entry running hooks/run-gate.mjs in hooks.json, found ${gates.length}`);
codex.hooks.Stop = gates;
fs.writeFileSync(codexFile, `${JSON.stringify(codex, null, 2)}\n`);
