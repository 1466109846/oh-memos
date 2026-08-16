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
import { handleMemosImportWiki } from "./wiki-import.js";
import { handleMemosCanvas } from "./canvas.js";
import { handleMemosDistillSkill, handleMemosListSkillCandidates, handleMemosReviewSkillCandidate, handleMemosInstallSkillCandidate } from "./skill.js";
import {
  handleMemosListCubes,
  handleMemosRegisterCube,
  handleMemosCreateUser,
  handleMemosValidateCubes,
  handleMemosDelete,
  handleMemosCapabilities,
} from "./admin.js";
import type { TextContent } from "../types.js";
import { MEMOS_URL, MEMOS_PROVIDER } from "../config.js";
import { errorResponse } from "./utils.js";

export async function dispatchTool(
  name: string,
  arguments_: Record<string, unknown>
): Promise<TextContent[]> {
  if (MEMOS_PROVIDER === "local" && ["memos_think", "memos_graph", "memos_export_wiki", "memos_import_wiki", "memos_admin", "memos_delete"].includes(name)) {
    return errorResponse(
      `Lite mode: ${name} is unavailable because it requires the Full HTTP/graph provider. ` +
      "Available Lite paths include memos_save, memos_list_v2, memos_get, memos_search, memos_suggest, memos_context_resume, and memos_canvas. " +
      "Set MEMOS_MODE=full and start the backend for Full-only operations."
    );
  }
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

    // Wiki export / import round-trip
    case "memos_export_wiki":
      return handleMemosExportWiki(arguments_);
    case "memos_import_wiki":
      return handleMemosImportWiki(arguments_);

    // Symbolic task canvas (local files, no API round trip)
    case "memos_canvas":
      return handleMemosCanvas(arguments_);
    case "memos_distill_skill":
      return handleMemosDistillSkill(arguments_);
    case "memos_list_skill_candidates":
      return handleMemosListSkillCandidates(arguments_);
    case "memos_review_skill_candidate":
      return handleMemosReviewSkillCandidate(arguments_);
    case "memos_install_skill_candidate":
      return handleMemosInstallSkillCandidate(arguments_);

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
        case "capabilities":
          return handleMemosCapabilities();
        case "calendar":
          return handleMemosCalendar(arguments_);
        default:
          return errorResponse(
            `Unknown admin action: ${String(arguments_.action ?? "(none)")}`,
            undefined,
            ["Valid actions: list_cubes, register_cube, create_user, validate_cubes, stats, calendar, capabilities"]
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
