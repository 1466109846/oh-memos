/**
 * Wiki import format tests.
 *
 * The parser must accept byte-exact output of handlers/wiki-export.ts
 * renderPage(): front-matter (generator/id/type/status/tags/confidence/
 * created/updated), an H1 title, free-form content, and an optional
 * "## 关联" wikilink section that is NOT part of the memory content.
 */

import { describe, expect, it } from "vitest";
import {
  buildMemoryContent,
  parseWikiPage,
  stripTypePrefix,
  WIKI_GENERATOR_MARKER,
} from "./wiki-import-format.js";

/** Byte-exact sample of what renderPage() emits for a fully-populated node. */
const FULL_PAGE = [
  "---",
  "generator: oh-memos-wiki-export",
  "id: 3f2a9c1e-1111-2222-3333-444455556666",
  "type: BUGFIX",
  "status: activated",
  'tags: ["neo4j", "datetime"]',
  "confidence: 0.9",
  "created: 2026-03-10T19:28:38+00:00",
  "updated: 2026-03-11T08:00:00+00:00",
  "---",
  "",
  "# Neo4j datetime fix",
  "",
  "Store every *_at field as native datetime on update.",
  "",
  "Second paragraph keeps blank lines and [BRACKETED] text.",
  "",
  "## 关联",
  "",
  "- 导致 → [[2026-03-09-some-page]]",
  "- 被上级 ← [[2026-03-01-root-page]]",
  "",
].join("\n");

/** Minimal page: no tags/confidence/dates, no 关联 section. */
const MINIMAL_PAGE = [
  "---",
  "generator: oh-memos-wiki-export",
  "id: abc-def-001",
  "type: DECISION",
  "status: activated",
  "---",
  "",
  "# Use Qdrant",
  "",
  "Vector recall goes to Qdrant.",
].join("\n");

describe("parseWikiPage", () => {
  it("parses a fully-populated exported page", () => {
    const result = parseWikiPage(FULL_PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.page;
    expect(p.id).toBe("3f2a9c1e-1111-2222-3333-444455556666");
    expect(p.type).toBe("BUGFIX");
    expect(p.status).toBe("activated");
    expect(p.tags).toEqual(["neo4j", "datetime"]);
    expect(p.confidence).toBe(0.9);
    expect(p.created).toBe("2026-03-10T19:28:38+00:00");
    expect(p.updated).toBe("2026-03-11T08:00:00+00:00");
    expect(p.title).toBe("Neo4j datetime fix");
    expect(p.content).toBe(
      "Store every *_at field as native datetime on update.\n\nSecond paragraph keeps blank lines and [BRACKETED] text."
    );
    expect(p.related).toEqual([
      "- 导致 → [[2026-03-09-some-page]]",
      "- 被上级 ← [[2026-03-01-root-page]]",
    ]);
  });

  it("defaults status and tags for a minimal page", () => {
    const result = parseWikiPage(MINIMAL_PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.status).toBe("activated");
    expect(result.page.tags).toEqual([]);
    expect(result.page.related).toEqual([]);
    expect(result.page.content).toBe("Vector recall goes to Qdrant.");
  });

  it("keeps CJK titles and content intact", () => {
    const page = [
      "---",
      "generator: oh-memos-wiki-export",
      "id: cjk-001",
      "type: GOTCHA",
      "status: activated",
      "---",
      "",
      "# 中文标题保留",
      "",
      "内容包含中文与 emoji ⚠️。",
    ].join("\n");
    const result = parseWikiPage(page);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.title).toBe("中文标题保留");
    expect(result.page.content).toBe("内容包含中文与 emoji ⚠️。");
  });

  it("parses tags containing escaped quotes and backslashes", () => {
    const page = MINIMAL_PAGE.replace(
      "status: activated",
      'status: activated\ntags: ["weird\\"tag", "back\\\\slash"]'
    );
    const result = parseWikiPage(page);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.tags).toEqual(['weird"tag', "back\\slash"]);
  });

  it("rejects a page without the exporter marker", () => {
    const foreign = FULL_PAGE.replace(WIKI_GENERATOR_MARKER, "generator: other-tool");
    expect(parseWikiPage(foreign).ok).toBe(false);
  });

  // The importer must distinguish "someone else's file, leave it alone" from
  // "our page, but broken" — the first is normal, the second is a real failure
  // worth reporting. Classification is a typed flag, not a message match.
  it("flags files that were never ours as foreign, not as failures", () => {
    const cases = [
      "# hand-written notes\n\nno front-matter at all",
      FULL_PAGE.replace(WIKI_GENERATOR_MARKER, "generator: other-tool"),
      "---\ntitle: some other tool's page\n---\n\n# hi",
      "---\nnever terminated\n\n# hi",
    ];
    for (const raw of cases) {
      const result = parseWikiPage(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.foreign, raw.slice(0, 24)).toBe(true);
    }
  });

  it("flags our own malformed pages as failures, not foreign", () => {
    const cases = [
      FULL_PAGE.replace("id: 3f2a9c1e-1111-2222-3333-444455556666\n", ""),
      FULL_PAGE.replace("type: BUGFIX", "type: bugfix"),
      MINIMAL_PAGE.replace("Vector recall goes to Qdrant.", ""),
      MINIMAL_PAGE.replace("# Use Qdrant", "Use Qdrant"),
    ];
    for (const raw of cases) {
      const result = parseWikiPage(raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.foreign).toBe(false);
    }
  });

  it("rejects a page with a missing id", () => {
    const noId = FULL_PAGE.replace("id: 3f2a9c1e-1111-2222-3333-444455556666\n", "");
    const result = parseWikiPage(noId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/id/i);
  });

  it("rejects types the server fast path cannot store", () => {
    for (const bad of ["bugfix", "TOO_LONG_TYPE_NAME_EXCEEDING_THE_LIMIT", "A", "WITH-DASH"]) {
      const page = FULL_PAGE.replace("type: BUGFIX", `type: ${bad}`);
      expect(parseWikiPage(page).ok, `type=${bad}`).toBe(false);
    }
  });

  it("rejects a page whose content is empty (title only)", () => {
    const empty = MINIMAL_PAGE.replace("Vector recall goes to Qdrant.", "");
    const result = parseWikiPage(empty);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/content/i);
  });

  it("rejects input without front-matter", () => {
    expect(parseWikiPage("# Just markdown\n\nno front-matter").ok).toBe(false);
  });

  it("normalizes Windows CRLF pages", () => {
    const result = parseWikiPage(FULL_PAGE.replace(/\n/g, "\r\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.content).not.toContain("\r");
  });

  it("rejects an unknown lifecycle status", () => {
    const result = parseWikiPage(FULL_PAGE.replace("status: activated", "status: retired"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.foreign).toBe(false);
  });
  it("surfaces non-activated status instead of importing silently", () => {
    const archived = FULL_PAGE.replace("status: activated", "status: archived");
    const result = parseWikiPage(archived);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.status).toBe("archived");
  });
});

describe("content round-trip helpers", () => {
  it("buildMemoryContent restores the exact string the exporter stripped", () => {
    const result = parseWikiPage(FULL_PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(buildMemoryContent(result.page)).toBe(
      "[BUGFIX] Store every *_at field as native datetime on update.\n\n" +
      "Second paragraph keeps blank lines and [BRACKETED] text."
    );
  });

  it("buildMemoryContent matches the server's typed fast-path prefix", () => {
    const result = parseWikiPage(FULL_PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // core.py MOS_TYPED_SAVE_FAST stores verbatim when content matches ^\[([A-Z_]{3,24})\]\s
    expect(buildMemoryContent(result.page)).toMatch(/^\[[A-Z_]{3,24}\]\s/);
  });

  it("stripTypePrefix is the inverse of the [TYPE] prefix", () => {
    const result = parseWikiPage(FULL_PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stripTypePrefix(buildMemoryContent(result.page))).toBe(result.page.content);
    expect(stripTypePrefix("no prefix here")).toBe("no prefix here");
  });
});
