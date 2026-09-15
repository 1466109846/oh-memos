import { describe, expect, it } from "vitest";
import { parseMemoryWriteResponse } from "./memory-write-response.js";

describe("parseMemoryWriteResponse", () => {
  it("returns IDs from the new API response", () => {
    expect(parseMemoryWriteResponse({
      code: 200,
      message: "Memories added successfully",
      data: { memory_ids: ["new-1", "new-2"], warnings: [] },
    })).toEqual({ memoryIds: ["new-1", "new-2"], warnings: [] });
  });

  it("keeps old APIs compatible when data is null or absent", () => {
    expect(parseMemoryWriteResponse({ code: 200, message: "ok", data: null }))
      .toEqual({ memoryIds: [], warnings: [] });
    expect(parseMemoryWriteResponse({ code: 200, message: "ok" }))
      .toEqual({ memoryIds: [], warnings: [] });
  });

  it("normalizes malformed optional fields without trusting the response", () => {
    expect(parseMemoryWriteResponse({
      code: 200,
      data: { memory_ids: ["ok", 42, ""], warnings: ["slow", 9] },
    })).toEqual({ memoryIds: ["ok"], warnings: ["slow"] });
  });

  it("distinguishes confirmed vector storage from pending LLM parsing", () => {
    expect(parseMemoryWriteResponse({
      code: 200,
      data: { memory_ids: ["raw-1"], vector_saved: true, enrichment_status: "pending" },
    })).toEqual({
      memoryIds: ["raw-1"], warnings: [], vectorSaved: true, enrichmentStatus: "pending",
    });
  });

  it("retains explicit vector failures even when the API allocated an ID", () => {
    expect(parseMemoryWriteResponse({
      code: 200,
      data: { memory_ids: ["unconfirmed-1"], vector_saved: false },
    })).toMatchObject({ vectorSaved: false });
  });
});
