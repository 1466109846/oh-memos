import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MEMOS_MODE = "full";
  process.env.MEMOS_PROVIDER = "api";
  process.env.MEMOS_URL = "http://stub";
  process.env.MEMOS_USER = "dev_user";
  process.env.MEMOS_DEFAULT_CUBE = "stub_cube";
  process.env.MEMOS_CUBES_DIR = process.cwd();
});

vi.mock("./cube-manager.js", () => ({
  ensureCubeRegistered: vi.fn(async (): Promise<[boolean, string | null]> => [
    true,
    null,
  ]),
  getDefaultCubeId: () => "stub_cube",
}));

// Detail rendering is under test; do not persist local usage data.
vi.mock("./access-tracker.js", () => ({ recordAccess: vi.fn() }));

import { handleMemosGet } from "./handlers/memory.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("memos_get creation time", () => {
  it("shows the same Created timestamp before and after background enrichment", async () => {
    const created = "2026-09-16T19:05:22Z";
    const enriched = "2026-09-16T19:09:07Z";
    const pending = {
      id: "vector-first-memory",
      memory: "[BUGFIX] Confirm vector storage before background parsing.",
      metadata: {
        created_at: created,
        updated_at: created,
        enrichment_status: "pending",
      },
    };
    const completed = {
      ...pending,
      metadata: {
        ...pending.metadata,
        updated_at: enriched,
        enrichment_status: "completed",
        key: "Vector-first save",
      },
    };
    const response = (data: typeof pending) =>
      new Response(JSON.stringify({ code: 200, message: "success", data }));
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(response(pending))
        .mockResolvedValueOnce(response(completed)),
    );
    const args = {
      project_path: "/tmp/created-at-test",
      memory_id: pending.id,
    };

    const before = await handleMemosGet(args);
    const after = await handleMemosGet(args);

    expect(before[0].text).toContain(`**Created**: ${created}`);
    expect(after[0].text).toContain("**Key**: Vector-first save");
    expect(after[0].text).toContain(`**Created**: ${created}`);
    expect(after[0].text).not.toContain(`**Created**: ${enriched}`);
  });
});
