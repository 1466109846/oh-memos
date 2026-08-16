/**
 * Tool Handler Dispatcher
 *
 * Graph and admin operations are consolidated behind memos_graph(mode) and
 * memos_admin(action): one schema on the tool surface, same handlers inside.
 */

import { handleMemosSave, handleMemosList, handleMemosGet, handleMemosGetStats } from "./memory.js";
import { handleMemosSearch, handleMemosSuggest, handleMemosContextResume } from "./search.js";
import { handleMemosTracePath, handleMemosGetGraph, handleMemosExportSchema, handleMemosImpact, handleMemosGraphifyImport } from "./graph.js";
import { handleMemosCalendar } from "./calendar.js";
import { handleMemosThink } from "./think.js";
import { handleMemosExportWiki } from "./wiki-export.js";
import { handleMemosCanvas } from "./canvas.js";
import {
  handleMemosListCubes,
  handleMemosRegisterCube,
  handleMemosCreateUser,
  handleMemosValidateCubes,
  handleMemosDelete,
} from "./admin.js";
import type { TextContent } from "../types.js";
import { MEMOS_URL } from "../config.js";
import { errorResponse } from "./utils.js";

export async function dispatchTool(
  name: string,
  arguments_: Record<string, unknown>
): Promise<TextContent[]> {
  switch (name) {
    // Memory tools
    case "memos_save":
      return handleMemosSave(arguments_);
    case "memos_list_v2":
      return handleMemosList(arguments_);
    case "memos_get":
      return handleMemosGet(arguments_);

    // Search tools
    case "memos_search":
      return handleMemosSearch(arguments_);
    case "memos_suggest":
      return handleMemosSuggest(arguments_);
    case "memos_context_resume":
      return handleMemosContextResume(arguments_);
    case "memos_think":
      return handleMemosThink(arguments_);

    // Graph (consolidated)
    case "memos_graph":
      switch (String(arguments_.mode ?? "related")) {
        case "path":
          return handleMemosTracePath(arguments_);
        case "impact":
          return handleMemosImpact(arguments_);
        case "schema":
          return handleMemosExportSchema(arguments_);
        case "import":
          return handleMemosGraphifyImport(arguments_);
        default:
          return handleMemosGetGraph(arguments_);
      }

    // Wiki export
    case "memos_export_wiki":
      return handleMemosExportWiki(arguments_);

    // Symbolic task canvas (local files, no API round trip)
    case "memos_canvas":
      return handleMemosCanvas(arguments_);

    // Admin (consolidated)
    case "memos_admin":
      switch (String(arguments_.action ?? "")) {
        case "list_cubes":
          return handleMemosListCubes(arguments_);
        case "register_cube":
          return handleMemosRegisterCube(arguments_);
        case "create_user":
          return handleMemosCreateUser(arguments_);
        case "validate_cubes":
          return handleMemosValidateCubes(arguments_);
        case "stats":
          return handleMemosGetStats(arguments_);
        case "calendar":
          return handleMemosCalendar(arguments_);
        default:
          return errorResponse(
            `Unknown admin action: ${String(arguments_.action ?? "(none)")}`,
            undefined,
            ["Valid actions: list_cubes, register_cube, create_user, validate_cubes, stats, calendar"]
          );
      }

    case "memos_delete":
      return handleMemosDelete(arguments_);

    default:
      return errorResponse(`Unknown tool: ${name}`);
  }
}

export async function handleApiUnreachable(): Promise<TextContent[]> {
  return [{
    type: "text",
    text: [
      `❌ [API_UNREACHABLE] Cannot connect to MemOS API at ${MEMOS_URL}`,
      "",
      "💡 Suggestions:",
      "- Check if MemOS API is running: `curl http://localhost:18000/health`",
      "- Start with: `scripts/local/start.bat`",
      "- Check port availability",
    ].join("\n"),
  }];
}
