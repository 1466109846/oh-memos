import { describe, expect, it } from "vitest";
import { toBrief, toFull, toMinimal } from "./models.js";
import type { MemoryNode } from "./types.js";

const CREATED = "2026-09-16T19:05:22Z";
const ENRICHED = "2026-09-16T19:09:07Z";

const memory: MemoryNode = {
  id: "vector-first-memory",
  memory: "[BUGFIX] Confirm vector storage before background parsing.",
};

describe("full memory creation time", () => {
  it("keeps the original creation time after background enrichment", () => {
    const pending = { ...memory, created_at: CREATED, updated_at: CREATED };
    const completed = { ...pending, updated_at: ENRICHED };

    expect(toFull(pending).createdAt).toBe(CREATED);
    expect(toFull(completed).createdAt).toBe(CREATED);
  });

  it("prefers a metadata creation time over a top-level update time", () => {
    expect(
      toFull({
        ...memory,
        updated_at: ENRICHED,
        metadata: { created_at: CREATED, updated_at: ENRICHED },
      }).createdAt,
    ).toBe(CREATED);
  });

  it("prefers a top-level creation time over a metadata creation time", () => {
    expect(
      toFull({
        ...memory,
        created_at: CREATED,
        updated_at: ENRICHED,
        metadata: { created_at: "2026-09-15T10:00:00Z" },
      }).createdAt,
    ).toBe(CREATED);
  });

  it.each([
    { updated_at: ENRICHED },
    { metadata: { updated_at: ENRICHED } },
  ])("falls back to the update time when creation time is absent: %j", (dates) => {
    expect(toFull({ ...memory, ...dates }).createdAt).toBe(ENRICHED);
  });

  it("omits the creation time when no timestamp is available", () => {
    expect(toFull(memory).createdAt).toBeUndefined();
  });

  it("keeps the update time in minimal and brief results", () => {
    const completed = { ...memory, created_at: CREATED, updated_at: ENRICHED };

    expect(toMinimal(completed).createdAt).toBe(ENRICHED);
    expect(toBrief(completed).createdAt).toBe(ENRICHED);
  });
});
