import { describe, expect, it } from "vitest";
import { applyMemoryQualityPolicy, memoryQualityScore } from "./memory-quality.js";
import type { MemoryNode, SearchData } from "./types.js";

const node = (id: string, extra: Record<string, unknown> = {}): MemoryNode => ({
  id,
  memory: `[DECISION] ${id}`,
  metadata: { relativity: 0.8, ...extra },
});

describe("memory quality policy", () => {
  it("down-ranks auto-capture and progress memories", () => {
    expect(memoryQualityScore(node("curated"))).toBeGreaterThan(
      memoryQualityScore(node("auto", { tags: ["auto-capture"], confidence: 0.25 }))
    );
    expect(memoryQualityScore(node("progress", { type: "PROGRESS" }))).toBeLessThan(1);
  });

  it("marks stale and expired records", () => {
    const stale = node("stale", {
      updated_at: "2020-01-01T00:00:00Z",
      expires_at: "2020-01-02T00:00:00Z",
    });
    const result = applyMemoryQualityPolicy({ text_mem: [{ cube_id: "c", memories: [stale] }] }, { now: Date.parse("2026-01-01T00:00:00Z") });
    const memory = result.text_mem![0].memories as MemoryNode[];
    expect(memory[0].metadata?.freshness).toBe("expired");
    expect(Number(memory[0].metadata?.quality_score)).toBeLessThan(0.5);
  });

  it("lite mode excludes auto-capture unless explicitly requested", () => {
    const data: SearchData = { text_mem: [{ cube_id: "c", memories: [node("a", { tags: ["auto-capture"] }), node("b")] }] };
    const filtered = applyMemoryQualityPolicy(data, { mode: "lite" });
    expect((filtered.text_mem![0].memories as MemoryNode[]).map((m) => m.id)).toEqual(["b"]);
  });

  it("sorts across cube buckets globally", () => {
    const data: SearchData = { text_mem: [
      { cube_id: "one", memories: [node("low", { relativity: 0.2 })] },
      { cube_id: "two", memories: [node("high", { relativity: 0.95 })] },
    ] };
    const result = applyMemoryQualityPolicy(data);
    expect((result.text_mem![0].memories as MemoryNode[])[0].id).toBe("high");
  });
});
