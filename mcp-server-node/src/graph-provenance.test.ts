import { describe, expect, it } from "vitest";
import {
  formatProvenance,
  normalizeProvenance,
  stableCodeNodeId,
} from "./graph-provenance.js";

describe("normalizeProvenance", () => {
  it("normalizes Graphify link fields into the oh-memos contract", () => {
    expect(normalizeProvenance({
      confidence: "EXTRACTED",
      source_file: "src/api/routes.py",
      source_location: "L42",
      weight: 1,
    })).toEqual({
      evidence_kind: "EXTRACTED",
      confidence_score: 1,
      evidence_refs: ["src/api/routes.py:L42"],
      source_file: "src/api/routes.py",
      source_location: "L42",
    });
  });

  it("keeps inferred scores, clamps invalid values, and de-duplicates refs", () => {
    expect(normalizeProvenance({
      evidence_kind: "inferred",
      confidence_score: 1.7,
      evidence_refs: ["mem:a", "mem:a", 42, "file:b"],
      source_ref: "file:b",
    })).toEqual({
      evidence_kind: "INFERRED",
      confidence_score: 1,
      evidence_refs: ["mem:a", "file:b"],
      source_ref: "file:b",
    });
  });

  it("does not over-claim provenance for legacy records", () => {
    expect(normalizeProvenance({})).toEqual({
      evidence_kind: "UNKNOWN",
      evidence_refs: [],
    });
  });
});

describe("formatProvenance", () => {
  it("renders an auditable compact explanation", () => {
    expect(formatProvenance({
      evidence_kind: "AMBIGUOUS",
      confidence_score: 0.42,
      source_file: "src/a.py",
      source_location: "L9-L12",
      evidence_refs: ["mem:123"],
    })).toBe("evidence=AMBIGUOUS; confidence=0.42; source=src/a.py:L9-L12; refs=mem:123");
  });
});

describe("stableCodeNodeId", () => {
  it("is deterministic across path separators and case", () => {
    const a = stableCodeNodeId("src\\API\\Routes.py", "Python", "Search Route");
    const b = stableCodeNodeId("src/api/routes.py", "python", "search route");
    expect(a).toBe(b);
    expect(a).toBe("code:src_api_routes_py:python:search_route");
  });

  it("rejects absolute and traversal paths", () => {
    expect(() => stableCodeNodeId("C:\\repo\\a.py", "python", "f")).toThrow(/relative/i);
    expect(() => stableCodeNodeId("../a.py", "python", "f")).toThrow(/relative/i);
  });
});
