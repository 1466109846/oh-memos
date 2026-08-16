import type { ApiResponse } from "./types.js";

export interface MemoryWriteResult {
  memoryIds: string[];
  warnings: string[];
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
  return { memoryIds, warnings };
}
