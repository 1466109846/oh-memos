import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { register } = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock("./providers/provider-factory.js", () => ({ getMemoryProvider: () => null }));
vi.mock("./api-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api-client.js")>(),
  waitForApiReady: vi.fn().mockResolvedValue(true),
}));
vi.mock("./cube-manager.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./cube-manager.js")>(),
  ensureCubeRegistered: register,
  getDefaultCubeId: () => "server_callback_cube",
}));

import { buildServer } from "./server.js";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
type SaveCallback = (args: Record<string, unknown>) => Promise<ToolResult>;

function saveCallback(): SaveCallback {
  const registration = vi.spyOn(McpServer.prototype, "registerTool");
  try {
    buildServer();
    const saveTool = registration.mock.calls.find(([name]) => name === "memos_save");
    expect(saveTool, "memos_save must be registered on the real server").toBeDefined();
    return saveTool![2] as unknown as SaveCallback;
  } finally {
    registration.mockRestore();
  }
}

function stubApi(data: Record<string, unknown>) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ code: 200, data }),
  } as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function args(content: string) {
  return { content, memory_type: "BUGFIX", project_path: "/projects/server-callback" };
}

beforeEach(() => {
  register.mockReset().mockResolvedValue([true, null]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registered memos_save callback results", () => {
  it.each([
    ["explicitly unconfirmed vector", { memory_ids: ["allocated-id"], vector_saved: false }],
    ["confirmation without IDs", { memory_ids: [], vector_saved: true }],
  ])("marks an %s as a protocol error and retains its message", async (label, payload) => {
    const fetchMock = stubApi(payload);

    const result = await saveCallback()(args(`Protocol ${label}`));

    expect(result).toEqual({
      isError: true,
      content: [{
        type: "text",
        text: [
          "❌ [VECTOR_SAVE_UNCONFIRMED] Vector storage was not confirmed; the save cannot be acknowledged.",
          "", "💡 Suggestions:",
          "- Check API storage logs and search for the memory before retrying.",
        ].join("\n"),
      }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["confirmed pending vector", {
      memory_ids: ["stored-pending-id"], vector_saved: true, enrichment_status: "pending",
    }],
    ["legacy memory ID", { memory_ids: ["legacy-server-id"] }],
    ["legacy response without IDs", {}],
    ["legacy warning containing an error-code label", {
      memory_ids: ["legacy-warning-id"], warnings: ["Historic VECTOR_SAVE_UNCONFIRMED incident"],
    }],
  ])("keeps %s as a normal successful result", async (label, payload) => {
    stubApi(payload);

    const result = await saveCallback()(args(`Protocol ${label}`));

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Memory saved");
    if ("enrichment_status" in payload) {
      expect(result.content[0].text).toContain("background");
    }
  });

  it("reports a response-body timeout as API_TIMEOUT without replaying the write", async () => {
    const timeout = new TypeError("terminated", {
      cause: Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" }),
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: vi.fn().mockRejectedValue(timeout),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveCallback()(args("Protocol response-body timeout"));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("[API_TIMEOUT]");
    expect(result.content[0].text).not.toContain("API_UNREACHABLE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
