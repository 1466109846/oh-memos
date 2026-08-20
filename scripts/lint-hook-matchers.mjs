#!/usr/bin/env node
/**
 * Lint gate: every Claude Code hook `matcher` in this repo must be a bare tool
 * name, a `|`/`,` separated list, or a wildcard.
 *
 * `matcher` is evaluated against the TOOL NAME only. Per the Claude Code docs, a
 * value containing any character outside [A-Za-z0-9_-, |*] is treated as an
 * unanchored JavaScript regex — so an expression like
 *
 *     "tool == \"Bash\" && tool_input.command matches \"mkdir.*memory\""
 *
 * gets matched against the string "Bash", never hits, and the hook silently
 * never fires. Nothing warns you. A shipped template carrying that typo hands
 * the same dead hook to every user who copies it.
 *
 * Argument-level conditions belong inside the hook script, or in the per-handler
 * `if` field (permission-rule syntax, e.g. "Edit(*.ts)").
 *
 * Also checks that referenced hook scripts exist, so a rename cannot leave the
 * template pointing at a missing file.
 *
 * Usage:  node scripts/lint-hook-matchers.mjs
 * Exits 1 on any violation.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

const SIMPLE_MATCHER = /^[A-Za-z0-9_\-, |*]*$/;

/**
 * Only TRACKED files are linted. What ships is what matters, and editor-local
 * config would otherwise produce noise the gate cannot act on:
 * .vscode/settings.json is JSONC (comments) rather than JSON, and .trae/ is
 * gitignored entirely.
 */
function trackedHookConfigs() {
  const out = execFileSync("git", ["ls-files", "-z", "*.json"], {
    encoding: "utf8",
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => /(settings|hook)[^/\\]*\.json$/i.test(f));
}

const problems = [];
let filesChecked = 0;
let matchersChecked = 0;

for (const file of trackedHookConfigs()) {
  let parsed;
  const text = readFileSync(file, "utf8");
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    problems.push(`${file}: not valid JSON — ${err.message}`);
    continue;
  }
  if (!parsed || typeof parsed !== "object" || !parsed.hooks) continue;
  filesChecked++;

  for (const [event, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.matcher !== undefined) {
        matchersChecked++;
        if (!SIMPLE_MATCHER.test(entry.matcher)) {
          problems.push(
            `${file}: ${event} matcher is an expression, so it is treated as a regex ` +
              `against the tool name and never fires:\n      ${JSON.stringify(entry.matcher)}`,
          );
        }
      }
      // Referenced scripts must exist. Paths using the <MEMOS_PATH> placeholder
      // resolve relative to the repo root.
      for (const handler of entry.hooks ?? []) {
        const cmd = handler.command;
        if (typeof cmd !== "string") continue;
        const m = cmd.match(/<MEMOS_PATH>\/\S*?node\/([a-z0-9_]+\.js)/i);
        if (!m) continue;
        // <MEMOS_PATH> is the USER's install root, so it cannot be resolved from
        // here. Every hook script sits in node/ beside the template that names
        // it, which holds for both the canonical copy and the deploy bundle.
        const target = join(dirname(file), "node", m[1]);
        if (!existsSync(target)) {
          problems.push(
            `${file}: ${event} references a missing script — node/${m[1]}`,
          );
        }
      }
    }
  }
}

const label = `${matchersChecked} matchers across ${filesChecked} hook config file(s)`;

if (problems.length) {
  console.error(`hook-matcher lint FAILED (${label})\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nFix: put the bare tool name in `matcher` (e.g. "Bash", "Edit|Write") and\n' +
      "move argument conditions into the hook script or the handler `if` field.\n" +
      "Reminder: a PreToolUse hook must exit 2 to block — exit 1 does not block.",
  );
  process.exit(1);
}

console.log(`hook-matcher lint passed — ${label}`);
