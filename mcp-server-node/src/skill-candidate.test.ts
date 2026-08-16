import { describe, expect, it } from "vitest";
import { renderSkillCandidate, skillCandidatePath } from "./skill-candidate.js";

describe("skill candidates", () => {
  it("renders a traceable, inert candidate", () => {
    const text = renderSkillCandidate({
      slug: "migration-locking",
      title: "Migration locking",
      summary: "Use advisory locks before migration work.",
      memoryIds: ["m1", "m2"],
      generatedAt: "2026-08-16T00:00:00Z",
    });
    expect(text).toContain("status: candidate");
    expect(text).toContain("source_memory_ids: [\"m1\", \"m2\"]");
    expect(text).toContain("Do not install automatically");
  });
  it("produces a safe markdown path", () => {
    expect(skillCandidatePath("G:/project", "Migration Locking").replace(/\\/g, "/")).toContain("skill-candidates/migration-locking.md");
    expect(skillCandidatePath("G:/project", "../../bad")).not.toContain("..");
  });
});
