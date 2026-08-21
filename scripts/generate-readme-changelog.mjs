#!/usr/bin/env node
/**
 * Render the N most recent changelog entries into the marked README block.
 *
 * The READMEs used to carry a hand-written "Recent highlights" list. Nothing
 * tied it to docs/CHANGELOG.md, so it was only as current as the last person
 * who remembered to edit two files by hand. This derives the list from the
 * changelog instead: write the changelog entry once, run this, done.
 *
 * Usage:
 *   node scripts/generate-readme-changelog.mjs           # report drift, exit 1 if any
 *   node scripts/generate-readme-changelog.mjs --write    # rewrite the marked block
 */

import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CHANGELOG = "docs/CHANGELOG.md";
export const ENTRY_COUNT = 6;
export const START = "<!-- changelog-recent:start -->";
export const END = "<!-- changelog-recent:end -->";

// Each README renders the block in its own language. The Chinese title is the
// `### ` heading itself; the English one comes from an `<!-- en: ... -->` comment
// directly beneath it, so both live on the entry and cannot drift apart.
export const TARGETS = [
  { file: "README.md", lang: "en" },
  { file: "README_CN.md", lang: "zh" },
];

export const EN_HINT = "<!-- en: <English title> -->";

/**
 * Normalise a version heading body: "[3.0.1] - 2026-08-19" -> "3.0.1 · 2026-08-19".
 * Returns null for a `##` heading that is not a version (e.g. "Contributing").
 */
export function formatVersion(headingBody) {
  const match = headingBody.match(/^\[([^\]]+)\]\s*(?:[-–—]\s*(.+?))?\s*$/);
  if (!match) return null;
  return match[2] ? `${match[1]} · ${match[2]}` : match[1];
}

/**
 * Collect `### ` entries in document order, each tagged with the `## [version]`
 * it sits under. Order is the changelog's own: the version numbers are not
 * monotonic (3.0.1 precedes 3.2.0, and 3.0.0 appears twice from a forked
 * release line), so sorting by version would reorder history incorrectly.
 */
export function parseEntries(markdown) {
  const entries = [];
  let version = null;
  let fenced = false;
  // Open only between a `### ` heading and its first line of prose, so an
  // `<!-- en: -->` further down the body cannot bind to the wrong entry.
  let awaitingEn = false;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();

    // A fence toggles verbatim mode. Inside one, `##` is sample code or a
    // Mermaid comment, not document structure.
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      awaitingEn = false;
      continue;
    }
    if (fenced) continue;

    if (awaitingEn && line !== "") {
      const en = line.match(/^<!--\s*en:\s*(.+?)\s*-->$/);
      if (en) entries[entries.length - 1].titleEn = en[1];
      // Any non-blank line ends the window, comment or not.
      awaitingEn = false;
      if (en) continue;
    }

    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      // Only a bracketed heading is a release. Trailing prose sections
      // ("Version History", "Contributing") must not re-tag later entries.
      const next = formatVersion(heading[1]);
      if (next) version = next;
      continue;
    }

    const entry = line.match(/^###\s+(.+?)\s*$/);
    if (entry) {
      entries.push({ version, title: entry[1], titleEn: null });
      awaitingEn = true;
    }
  }

  return entries;
}

export const UNRELEASED = "Unreleased";

/**
 * Tag released entries with their version; leave unreleased ones bare.
 *
 * Prefixing every line with `Unreleased` is pure noise while that section is
 * the newest one — and it usually is, since entries accumulate there between
 * releases. Omitting it means a released version number stands out on the lines
 * that have one, which is the distinction a reader is actually after.
 */
export function renderBlock(entries, lang = "zh") {
  return entries
    .map((e) => {
      const tag =
        e.version && e.version !== UNRELEASED ? `\`${e.version}\` — ` : "";
      // A missing English title is rejected in main() rather than falling back
      // silently, so a new entry cannot quietly ship as Chinese-only.
      const title = lang === "en" ? (e.titleEn ?? e.title) : e.title;
      return `- ${tag}${title}`;
    })
    .join("\n");
}

/**
 * Swap the marked region's contents, preserving the file's existing line
 * endings. Both READMEs are CRLF in this repo; writing LF would rewrite every
 * line and break the byte-exact diagram comparison in architecture-docs.test.ts.
 */
export function replaceMarkedBlock(source, block) {
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 || end === -1 || end <= start) return null;

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const body = block.split("\n").join(eol);
  return (
    source.slice(0, start + START.length) + eol + body + eol + source.slice(end)
  );
}

function main() {
  const write = process.argv.includes("--write");

  const all = parseEntries(readFileSync(CHANGELOG, "utf8"));
  const entries = all.slice(0, ENTRY_COUNT);
  if (entries.length < ENTRY_COUNT) {
    console.error(
      `${CHANGELOG}: parsed only ${entries.length} entries, expected at least ${ENTRY_COUNT}.`,
    );
    process.exit(1);
  }

  // Only the rendered window needs an English title, so older entries below the
  // cutoff never have to be back-translated.
  const untranslated = entries.filter((e) => !e.titleEn);
  if (untranslated.length > 0) {
    console.error(
      `${CHANGELOG}: ${untranslated.length} of the newest ${ENTRY_COUNT} entries have no English title.\n`,
    );
    for (const e of untranslated) console.error(`  - ### ${e.title}`);
    console.error(
      `\nAdd ${EN_HINT} on the line below each heading so README.md can render it.`,
    );
    process.exit(1);
  }

  const drift = [];

  for (const { file, lang } of TARGETS) {
    const source = readFileSync(file, "utf8");
    const next = replaceMarkedBlock(source, renderBlock(entries, lang));
    if (next === null) {
      console.error(`${file}: missing or malformed ${START} / ${END} markers.`);
      process.exit(1);
    }
    if (next !== source) drift.push({ file, next });
  }

  if (drift.length === 0) {
    console.log(
      `READMEs in sync with ${CHANGELOG} (${entries.length} entries)`,
    );
    process.exit(0);
  }

  if (!write) {
    console.error(`README changelog block is stale in:\n`);
    for (const d of drift) console.error(`  - ${d.file}`);
    console.error("\nRun: node scripts/generate-readme-changelog.mjs --write");
    process.exit(1);
  }

  for (const d of drift) {
    writeFileSync(d.file, d.next);
    console.log(`  updated: ${d.file}`);
  }
  console.log(`\n${drift.length} file(s) updated.`);
}

const invoked = process.argv[1];
if (
  invoked &&
  realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
