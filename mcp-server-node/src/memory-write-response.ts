import type { ApiResponse, TextContent } from "./types.js";

/** A rejected storage acknowledgement must be an MCP tool error, not success text. */
export class UnconfirmedMemoryWriteError extends Error {
  constructor(readonly content: TextContent[]) {
    super(content.map((item) => item.text).join("\n"));
    this.name = "UnconfirmedMemoryWriteError";
  }
}

export interface MemoryWriteResult {
  memoryIds: string[];
  warnings: string[];
  vectorSaved?: boolean;
  enrichmentStatus?: string;
}

/** Normalize the additive POST /memories response while accepting legacy APIs. */
export function parseMemoryWriteResponse(response: ApiResponse<unknown>): MemoryWriteResult {
  const data = response.data;
  if (!data || typeof data !== "object") return { memoryIds: [], warnings: [] };
  const payload = data as Record<string, unknown>;
  const memoryIds = Array.isArray(payload.memory_ids)
    ? payload.memory_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((warning): warning is string => typeof warning === "string" && warning.length > 0)
    : [];
  return {
    memoryIds, warnings,
    ...(typeof payload.vector_saved === "boolean" ? { vectorSaved: payload.vector_saved } : {}),
    ...(typeof payload.enrichment_status === "string" ? { enrichmentStatus: payload.enrichment_status } : {}),
  };
}
