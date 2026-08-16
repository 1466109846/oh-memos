import { describe, expect, it } from "vitest";
import { inspectWikiPages, normalizeLedger } from "./wiki-import-safety.js";

describe("wiki import safety", () => {
  it("rejects duplicate page IDs before writes", () => {
    const result = inspectWikiPages([
      { id: "same", relPath: "a.md" },
      { id: "same", relPath: "nested/b.md" },
      { id: "other", relPath: "c.md" },
    ]);
    expect(result.duplicates).toEqual([{ id: "same", paths: ["a.md", "nested/b.md"] }]);
    expect(result.ok).toBe(false);
  });

  it("accepts unique IDs", () => {
    expect(inspectWikiPages([{ id: "a", relPath: "a.md" }, { id: "b", relPath: "b.md" }])).toEqual({ ok: true, duplicates: [] });
  });

  it("distinguishes a corrupt ledger from a missing ledger", () => {
    expect(normalizeLedger(undefined)).toEqual({ ok: true, ledger: {} });
    expect(normalizeLedger({ a: "hash" }).ok).toBe(true);
    expect(normalizeLedger([]).ok).toBe(false);
    expect(normalizeLedger(null).ok).toBe(false);
  });
});
