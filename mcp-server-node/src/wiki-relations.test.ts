import { describe, expect, it } from "vitest";
import { EDGE_LABELS, buildFileBaseIndex, parseRelatedLine, relationEdges } from "./wiki-relations.js";

describe("wiki relation parsing", () => {
  it("parses a forward wikilink into a typed edge", () => {
    expect(parseRelatedLine("- 导致 → [[2026-03-09-some-page]]")).toEqual({
      relationType: "CAUSE",
      targetFileBase: "2026-03-09-some-page",
      reverse: false,
    });
  });

  it("parses a reverse wikilink and keeps the original direction", () => {
    expect(parseRelatedLine("- 被上级 ← [[2026-03-01-root-page]]")).toEqual({
      relationType: "PARENT",
      targetFileBase: "2026-03-01-root-page",
      reverse: true,
    });
  });

  it("covers every exported edge label", () => {
    for (const [type, label] of Object.entries(EDGE_LABELS)) {
      expect(parseRelatedLine(`- ${label} → [[page]]`)).toEqual({ relationType: type, targetFileBase: "page", reverse: false });
      expect(parseRelatedLine(`- 被${label} ← [[page]]`)).toEqual({ relationType: type, targetFileBase: "page", reverse: true });
    }
  });

  it("falls back to RELATE for an unknown label but keeps the target", () => {
    expect(parseRelatedLine("- 未知关系 → [[page]]")).toEqual({ relationType: "RELATE", targetFileBase: "page", reverse: false });
  });

  it("rejects lines that are not wikilinks", () => {
    for (const bad of ["- 导致 page", "just text", "- [[no-arrow]]", "- 导致 → [[]]"]) {
      expect(parseRelatedLine(bad), bad).toBeNull();
    }
  });
});

describe("fileBase index", () => {
  it("maps page file names to memory ids", () => {
    const index = buildFileBaseIndex([
      { id: "id-a", relPath: "pages/BUGFIX/2026-03-09-some-page.md" },
      { id: "id-b", relPath: "pages/DECISION/2026-03-01-root-page.md" },
    ]);
    expect(index.get("2026-03-09-some-page")).toBe("id-a");
    expect(index.get("2026-03-01-root-page")).toBe("id-b");
  });

  it("ignores duplicate file bases rather than silently picking one", () => {
    const index = buildFileBaseIndex([
      { id: "id-a", relPath: "pages/BUGFIX/same.md" },
      { id: "id-b", relPath: "pages/DECISION/same.md" },
    ]);
    expect(index.has("same")).toBe(false);
  });
});

describe("relationEdges", () => {
  const index = new Map([["target-page", "target-id"]]);

  it("orients forward and reverse edges correctly", () => {
    const edges = relationEdges("source-id", ["- 导致 → [[target-page]]", "- 被上级 ← [[target-page]]"], index);
    expect(edges.resolved).toEqual([
      { sourceId: "source-id", targetId: "target-id", relationType: "CAUSE" },
      { sourceId: "target-id", targetId: "source-id", relationType: "PARENT" },
    ]);
    expect(edges.unresolved).toEqual([]);
  });

  it("reports unresolved targets instead of inventing ids", () => {
    const edges = relationEdges("source-id", ["- 导致 → [[missing-page]]"], index);
    expect(edges.resolved).toEqual([]);
    expect(edges.unresolved).toEqual(["missing-page"]);
  });

  it("drops self edges and duplicates", () => {
    const selfIndex = new Map([["self-page", "source-id"], ["target-page", "target-id"]]);
    const edges = relationEdges("source-id", [
      "- 导致 → [[self-page]]",
      "- 导致 → [[target-page]]",
      "- 导致 → [[target-page]]",
    ], selfIndex);
    expect(edges.resolved).toEqual([{ sourceId: "source-id", targetId: "target-id", relationType: "CAUSE" }]);
    expect(edges.skippedSelf).toBe(1);
  });
});
