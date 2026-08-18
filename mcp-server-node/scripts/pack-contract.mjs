#!/usr/bin/env node

// Verify the npm package boundary without creating or publishing an archive.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : npmCommand;
const args = process.platform === "win32"
  ? ["/d", "/s", "/c", `${npmCommand} ${npmArgs.join(" ")}`]
  : npmArgs;
const result = spawnSync(command, args, {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}

const raw = `${result.stdout}\n${result.stderr}`;
const start = raw.indexOf("[");
const end = raw.lastIndexOf("]");
if (start === -1 || end <= start) {
  throw new Error(`npm pack did not return JSON metadata:\n${raw.slice(0, 2000)}`);
}
const metadata = JSON.parse(raw.slice(start, end + 1));
const files = (metadata[0]?.files ?? []).map((entry) => entry.path).sort();
const required = ["dist/index.js", "README.md", "CHANGELOG.md", ".env.example"];
const forbidden = [
  /^src\//,
  /^scripts\//,
  /\.test\.(?:js|ts)$/,
  /(?:vitest|tsconfig|package-lock)/i,
  /@modelcontextprotocol[\\/]client/i,
];

const missing = required.filter((path) => !files.includes(path));
const leaked = files.filter((path) => forbidden.some((pattern) => pattern.test(path)));
if (missing.length || leaked.length) {
  if (missing.length) console.error(`missing required package files: ${missing.join(", ")}`);
  if (leaked.length) console.error(`development files leaked into package: ${leaked.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`npm pack dry-run contract passed (${files.length} files)`);
  console.log(files.join("\n"));
}
