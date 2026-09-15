import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiCall, register } = vi.hoisted(() => ({ apiCall: vi.fn(), register: vi.fn() }));
vi.mock("./providers/provider-factory.js", () => ({ getMemoryProvider: () => null }));
vi.mock("./api-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api-client.js")>(), apiCallWithRetry: apiCall,
}));
vi.mock("./cube-manager.js", () => ({
  ensureCubeRegistered: register, getDefaultCubeId: () => "unused_default_cube",
}));

import { handleMemosSave } from "./handlers/memory.js";

function response(data: Record<string, unknown>) {
  return { success: true, status: 200, data: { code: 200, data } };
}

beforeEach(() => {
  apiCall.mockReset();
  register.mockResolvedValue([true, null]);
});

describe("MCP vector-first save", () => {
  it("returns the confirmed ID while LLM parsing is pending", async () => {
    apiCall.mockResolvedValue(response({
      memory_ids: ["raw-1"], vector_saved: true, enrichment_status: "pending", queued: false,
    }));
    const result = await handleMemosSave({
      content: "LLM parsing can take five minutes", memory_type: "BUGFIX",
      project_path: "/projects/vector-first",
    });
    expect(result[0].text).toContain("raw-1");
    expect(result[0].text).toContain("background");
    expect(apiCall).toHaveBeenCalledTimes(1);
    expect(apiCall.mock.calls[0][3].body).toMatchObject({
      mem_cube_id: "vector_first_cube", memory_type: "BUGFIX",
      memory_content: "[BUGFIX] LLM parsing can take five minutes",
    });
  });

  it("does not cache a save whose vector was not confirmed", async () => {
    apiCall.mockResolvedValueOnce(response({ memory_ids: ["allocated-1"], vector_saved: false }))
      .mockResolvedValueOnce(response({ memory_ids: ["stored-1"], vector_saved: true, enrichment_status: "pending" }));
    const args = {
      content: "Only durable vectors count as saved", memory_type: "ERROR_PATTERN",
      project_path: "/projects/vector-first",
    };
    await expect(handleMemosSave(args)).rejects.toMatchObject({
      name: "UnconfirmedMemoryWriteError",
      content: [{ type: "text", text: expect.stringContaining("VECTOR_SAVE_UNCONFIRMED") }],
    });
    const retry = await handleMemosSave(args);
    expect(retry[0].text).toContain("stored-1");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });

  it("requires an actual ID when the new API claims vector confirmation", async () => {
    apiCall.mockResolvedValue(response({ memory_ids: [], vector_saved: true }));
    await expect(handleMemosSave({
      content: "Confirmation needs a stored ID", memory_type: "BUGFIX",
      project_path: "/projects/vector-first",
    })).rejects.toMatchObject({
      name: "UnconfirmedMemoryWriteError",
      content: [{ type: "text", text: expect.stringContaining("VECTOR_SAVE_UNCONFIRMED") }],
    });
  });

  it("accepts successful legacy APIs without the additive fields", async () => {
    apiCall.mockResolvedValue(response({ memory_ids: ["legacy-1"] }));
    const result = await handleMemosSave({
      content: "Legacy server compatibility", memory_type: "BUGFIX",
      project_path: "/projects/vector-first",
    });
    expect(result[0].text).toContain("Memory saved");
    expect(result[0].text).toContain("legacy-1");
  });

  it("only adds dedup protection after a confirmed response includes its ID", async () => {
    apiCall.mockResolvedValueOnce(response({ memory_ids: [], vector_saved: true }))
      .mockResolvedValueOnce(response({ memory_ids: ["confirmed-dedup-1"], vector_saved: true }));
    const args = {
      content: "A response without an ID must not poison dedup", memory_type: "BUGFIX",
      project_path: "/projects/vector-first",
    };

    await expect(handleMemosSave(args)).rejects.toMatchObject({ name: "UnconfirmedMemoryWriteError" });
    expect((await handleMemosSave(args))[0].text).toContain("confirmed-dedup-1");
    expect((await handleMemosSave(args))[0].text).toContain("dedup protection");
    expect(apiCall).toHaveBeenCalledTimes(2);
  });
});
