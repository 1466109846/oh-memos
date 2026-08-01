#!/usr/bin/env node
/**
 * Schema token budget.
 *
 * Every tool's name, description, inputSchema and annotations are sent to the
 * model in `tools/list` on **every turn**, before the user has said anything.
 * That cost is invisible while you edit a description, and it only ever moves
 * one way. This measures it and fails the build when it drifts.
 *
 * Two notes on method:
 *
 * - The JSON Schema is produced with the SDK's own converter
 *   (`toJsonSchemaCompat`), so the bytes counted are the bytes actually put on
 *   the wire — not an approximation of them.
 * - Tokens are approximated from bytes rather than measured with a tokenizer.
 *   Installing tiktoken for a housekeeping script is a poor trade, and the
 *   number that matters here is *relative drift*, which bytes track faithfully.
 *   The divisor is a blend: Chinese runs ~2 bytes/token in UTF-8, English ~4.
 *
 * Usage:
 *   node scripts/schema-budget.mjs            # report
 *   node scripts/schema-budget.mjs --check    # compare to baseline, exit 1 on breach
 *   node scripts/schema-budget.mjs --write    # freeze current numbers as the baseline
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BASELINE_PATH = join(ROOT, "schema-baseline.json");
const DIST_REGISTRY = join(ROOT, "dist", "tools-registry.js");

const BYTES_PER_TOKEN = 3.2;
const DRIFT_THRESHOLD = 0.05; // +5% over baseline total fails --check
const TOP_N = 5;

/** Tools the server only registers under a flag — they are not part of the per-turn floor. */
const CONDITIONAL_TOOLS = new Set(["memos_delete"]);

const bytes = (s) => Buffer.byteLength(s, "utf8");
const tokens = (b) => Math.round(b / BYTES_PER_TOKEN);
const pct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

async function measure() {
  if (!existsSync(DIST_REGISTRY)) {
    console.error(`✗ ${DIST_REGISTRY} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const { toolSchemas, toolAnnotations } = await import(`file://${DIST_REGISTRY}`);
  const { toJsonSchemaCompat } = await import(
    "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js"
  );

  const tools = {};
  for (const [name, schema] of Object.entries(toolSchemas)) {
    const jsonSchema = toJsonSchemaCompat(schema.inputSchema, {
      strictUnions: true,
      pipeStrategy: "input",
    });
    // Mirrors the shape the SDK emits per tool in tools/list.
    const wireEntry = {
      name,
      description: schema.description,
      inputSchema: jsonSchema,
      annotations: toolAnnotations?.[name],
    };
    tools[name] = {
      descriptionBytes: bytes(schema.description ?? ""),
      schemaBytes: bytes(JSON.stringify(jsonSchema)),
      totalBytes: bytes(JSON.stringify(wireEntry)),
      conditional: CONDITIONAL_TOOLS.has(name) || undefined,
    };
  }

  const totalBytes = Object.values(tools).reduce((a, t) => a + t.totalBytes, 0);
  const conditionalBytes = Object.entries(tools)
    .filter(([n]) => CONDITIONAL_TOOLS.has(n))
    .reduce((a, [, t]) => a + t.totalBytes, 0);

  return {
    bytesPerTokenAssumed: BYTES_PER_TOKEN,
    toolCount: Object.keys(tools).length,
    totalBytes,
    alwaysOnBytes: totalBytes - conditionalBytes,
    tools,
  };
}

function report(current, baseline) {
  const ranked = Object.entries(current.tools).sort((a, b) => b[1].totalBytes - a[1].totalBytes);

  console.log("Tool surface — what every turn pays before the user speaks\n");
  console.log(`  tools:        ${current.toolCount}`);
  console.log(
    `  total:        ${current.totalBytes} B  ≈ ${tokens(current.totalBytes)} tokens`
  );
  console.log(
    `  always-on:    ${current.alwaysOnBytes} B  ≈ ${tokens(current.alwaysOnBytes)} tokens ` +
      `(excludes ${[...CONDITIONAL_TOOLS].join(", ")}, registered only under a flag)`
  );

  console.log(`\n  Most expensive ${TOP_N}:`);
  for (const [name, t] of ranked.slice(0, TOP_N)) {
    const share = ((t.totalBytes / current.totalBytes) * 100).toFixed(1);
    console.log(
      `    ${name.padEnd(24)} ${String(t.totalBytes).padStart(5)} B  (${share.padStart(4)}%)  ` +
        `desc ${t.descriptionBytes} / schema ${t.schemaBytes}`
    );
  }

  if (!baseline) {
    console.log(`\n  No baseline yet — freeze one with \`--write\`.`);
    return;
  }

  const drift = (current.totalBytes - baseline.totalBytes) / baseline.totalBytes;
  console.log(
    `\n  Baseline:     ${baseline.totalBytes} B → now ${current.totalBytes} B  (${pct(drift)})`
  );

  // Per-tool movement is the actionable part: a total that crept up is only
  // useful if you can see which description did the creeping.
  const moved = Object.entries(current.tools)
    .map(([name, t]) => [name, t.totalBytes - (baseline.tools[name]?.totalBytes ?? 0)])
    .filter(([, delta]) => delta !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  if (moved.length > 0) {
    console.log("\n  Changed since baseline:");
    for (const [name, delta] of moved) {
      const isNew = !(name in baseline.tools);
      console.log(
        `    ${delta > 0 ? "▲" : "▼"} ${name.padEnd(24)} ${delta > 0 ? "+" : ""}${delta} B${isNew ? "  (new tool)" : ""}`
      );
    }
  }
  for (const name of Object.keys(baseline.tools)) {
    if (!(name in current.tools)) console.log(`    ✗ ${name.padEnd(24)} removed`);
  }

  return drift;
}

async function main() {
  const args = process.argv.slice(2);
  const current = await measure();
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
    : null;

  if (args.includes("--write")) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    console.log(`✓ Baseline frozen: ${current.totalBytes} B ≈ ${tokens(current.totalBytes)} tokens`);
    console.log(`  ${BASELINE_PATH}`);
    return;
  }

  const drift = report(current, baseline);

  if (args.includes("--check")) {
    if (!baseline) {
      console.error("\n✗ --check needs a baseline. Run with --write once, and commit the file.");
      process.exit(2);
    }
    if (drift > DRIFT_THRESHOLD) {
      console.error(
        `\n✗ Tool surface grew ${pct(drift)}, over the ${pct(DRIFT_THRESHOLD)} budget.`
      );
      console.error("  Either trim a description, or re-freeze with --write if the growth is earned.");
      process.exit(1);
    }
    console.log(`\n✓ Within budget (${pct(drift)} vs ${pct(DRIFT_THRESHOLD)} allowed).`);
  }
}

main().catch((err) => {
  console.error(`✗ schema-budget failed: ${err?.stack ?? err}`);
  process.exit(2);
});
