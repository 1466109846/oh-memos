/**
 * MemOS MCP Server - Tools Registry
 *
 * Defines all 11 memos_* tool schemas using Zod (graph/admin operations are
 * consolidated behind mode/action parameters to keep the always-on tool
 * surface small).
 */

import { z } from "zod";
import { MEMOS_DEFAULT_CUBE } from "./config.js";

// ============================================================================
// Shared Parameter Schemas
// ============================================================================

const projectPathParam = z
  .string()
  .optional()
  .describe(
    "Your current working directory (project root). The cube_id will be auto-derived from this path. " +
    "PREFERRED over manually specifying cube_id. Example: '/mnt/g/Cyber/AudioCraft Studio' → 'audiocraft_studio_cube'"
  );

const cubeIdParam = z
  .string()
  .optional()
  .default(MEMOS_DEFAULT_CUBE)
  .describe(
    "Memory cube ID. Only use if you know the exact cube_id. PREFER passing project_path instead — " +
    "if both project_path and cube_id are omitted, the server falls back to the default cube, " +
    "which may NOT be your project's cube."
  );

// Brief variants for every tool except the hot paths (save/search): the full
// routing story is told once there; repeating it on every tool cost ~1.4k
// tokens of pure duplication on the tool surface.
const projectPathBrief = z.string().optional()
  .describe("Project root; cube_id is derived from it (details: memos_search)");
const cubeIdBrief = z.string().optional()
  .describe("Explicit cube id; prefer project_path");
const cubeIdBriefDefault = cubeIdBrief.default(MEMOS_DEFAULT_CUBE);

const memoryTypeEnum = z.enum([
  "ERROR_PATTERN", "DECISION", "MILESTONE", "BUGFIX",
  "FEATURE", "CONFIG", "CODE_PATTERN", "GOTCHA", "PROGRESS", "SYNTHESIS",
]);

// ============================================================================
// Tool Schema Definitions
// ============================================================================

export const toolSchemas = {
  memos_context_resume: {
    description: `Recover project context after context compaction or at session start: returns recent memories (24h) + project state.
Afterwards use memos tools for ALL memory operations — never mkdir/Write memory files.`,
    inputSchema: z.object({
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
    }),
  },

  memos_search: {
    description: `Search project memories. Use PROACTIVELY: on errors (ERROR_PATTERN), before modifying tricky code (GOTCHA), for past decisions (DECISION), when user says "之前/上次/previously", and after context compaction.
Query may carry a type prefix ("DECISION auth"). Pass context (recent turns) when the query is ambiguous or refers to earlier conversation — enables LLM intent analysis + query expansion.
Large results are compacted; use memos_get(memory_id) for full details. NEVER create memory files via mkdir/Write — all memories live here.`,
    inputSchema: z.object({
      query: z.string().describe(
        "Search query. Can be natural language or prefixed with memory type (e.g., 'ERROR_PATTERN ModuleNotFoundError')"
      ),
      context: z.array(z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })).optional().describe("Recent conversation turns (last 5-10); triggers context-aware search"),
      project_path: projectPathParam,
      cube_id: cubeIdParam,
      top_k: z.number().int().optional().default(10).describe("Max results (default 10)"),
      compact: z.boolean().optional().default(true).describe("Compact large results (default true)"),
    }),
  },

  memos_think: {
    description: `Evidence pack for a question: retrieves memories, flags contradiction/staleness candidates and coverage gaps.
YOU synthesize the answer from it, citing [n]; persist valuable syntheses via memos_save(memory_type="SYNTHESIS") keeping the [n]→id map.`,
    inputSchema: z.object({
      query: z.string().describe("The question to gather evidence for"),
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
      top_k: z.number().int().optional().default(15).describe("Evidence pool size (3-30)"),
      fresh_days: z.number().int().optional().default(30).describe("Days before time-sensitive memories count as stale"),
    }),
  },

  memos_export_wiki: {
    description: `Export a cube as an interlinked markdown wiki (page per memory + index.md + graph.md), git-friendly.
Default output <project_path>/docs/memory-wiki; re-export replaces only files it generated, foreign files are kept.`,
    inputSchema: z.object({
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
      output_dir: z.string().optional().describe("Target directory (default: <project_path>/docs/memory-wiki)"),
      include_archived: z.boolean().optional().default(false).describe("Also export archived memories"),
    }),
  },

  memos_save: {
    description: `Save important information to project memory — after fixing a bug, making a decision, finishing a milestone, hitting a gotcha, or changing config.
🚨 MUST pass memory_type explicitly (decision tree: memos_suggest).
This is the ONLY way to persist memories — never mkdir/Write memory files.`,
    inputSchema: z.object({
      content: z.string().describe("Memory content. Be detailed — include context, rationale, relevant code/commands."),
      memory_type: memoryTypeEnum.describe(
        "**REQUIRED**. bug fix → BUGFIX/ERROR_PATTERN · decision → DECISION · gotcha → GOTCHA · " +
        "template → CODE_PATTERN · config → CONFIG · feature → FEATURE · achievement → MILESTONE · " +
        "status update → PROGRESS · synthesized answer → SYNTHESIS. Full rules: memos_suggest"
      ),
      project_path: projectPathParam,
      cube_id: cubeIdParam,
    }),
  },

  memos_list_v2: {
    description: `List memories from a cube (compacted when large; memos_get for details).`,
    inputSchema: z.object({
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
      limit: z.number().int().optional().default(20).describe("Max memories returned"),
      memory_type: memoryTypeEnum.optional().describe("Filter by type"),
      compact: z.boolean().optional().default(true).describe("Compact large results"),
    }),
  },

  memos_get: {
    description: `Get full details of one memory by ID (after compacted memos_search/memos_list_v2 results).`,
    inputSchema: z.object({
      memory_id: z.string().describe("Memory ID from search/list results"),
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
    }),
  },

  memos_suggest: {
    description: `Suggest search queries for the current context, and return the memory_type decision tree.

Use when: unsure what to search for, or unsure which memory_type \`memos_save\` should use.`,
    inputSchema: z.object({
      context: z.string().describe("Current context (error message, code, user question)"),
    }),
  },

  memos_graph: {
    description: `Knowledge-graph queries; mode selects:
related = nodes+edges around a query · path = trace between two node ids · impact = forward blast radius of one memory · schema = graph structure & statistics.`,
    inputSchema: z.object({
      mode: z.enum(["related", "path", "impact", "schema"]).describe("Query kind"),
      query: z.string().optional().describe("related: search query"),
      source_id: z.string().optional().describe("path: start node id"),
      target_id: z.string().optional().describe("path: end node id"),
      memory_id: z.string().optional().describe("impact: source memory id"),
      max_depth: z.number().int().optional().default(3).describe("path/impact: max hops"),
      sample_size: z.number().int().optional().default(100).describe("schema: nodes sampled"),
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
    }),
  },

  memos_admin: {
    description: `Maintenance & diagnostics; action selects:
list_cubes · register_cube (fix "not loaded") · create_user (fix "user does not exist") · validate_cubes (repair config mismatches) · stats (per-type counts) · calendar (milestone timeline).`,
    inputSchema: z.object({
      action: z.enum(["list_cubes", "register_cube", "create_user", "validate_cubes", "stats", "calendar"]).describe("Operation"),
      cube_id: cubeIdBrief,
      project_path: projectPathBrief,
      cube_path: z.string().optional().describe("register_cube: cube directory (auto-detected if omitted)"),
      user_id: z.string().optional().describe("create_user: user id"),
      user_name: z.string().optional().describe("create_user: display name"),
      fix: z.boolean().optional().default(true).describe("validate_cubes: auto-fix"),
      include_status: z.boolean().optional().default(false).describe("list_cubes: check registration"),
      mode: z.enum(["project", "student"]).optional().describe("calendar: view mode"),
      semester: z.string().optional().describe("calendar student: 'YYYY-Season' or 'current'"),
      course: z.string().optional().describe("calendar student: course filter"),
      week: z.number().int().optional().describe("calendar student: week 1-18"),
      view: z.enum(["list", "week", "month"]).optional().describe("calendar student: format"),
    }),
  },

  // Delete tool schema (registered conditionally)
  memos_delete: {
    description: `⚠️ DELETE memories from project memory. USE WITH CAUTION!

This tool is DISABLED by default. User must explicitly enable it via MEMOS_ENABLE_DELETE=true.

ONLY use this tool when the user EXPLICITLY requests deletion.
NEVER use this tool proactively or without user confirmation.

Operations:
- Delete a single memory by ID
- Delete multiple memories by IDs
- Delete ALL memories in a cube (requires delete_all=true)

Before deleting, always:
1. Confirm with the user what will be deleted
2. Show the memory content that will be deleted
3. Get explicit user approval`,
    inputSchema: z.object({
      memory_id: z.string().optional().describe("ID of the specific memory to delete. Get this from memos_search or memos_list."),
      memory_ids: z.array(z.string()).optional().describe("List of memory IDs to delete in batch."),
      project_path: projectPathBrief,
      cube_id: cubeIdBriefDefault,
      delete_all: z.boolean().optional().default(false).describe("Set to true to delete ALL memories in the cube. DANGEROUS! Requires explicit user confirmation."),
    }),
  },
};

// ============================================================================
// Tool Annotations
// ============================================================================

/**
 * Every tool that changes state. This is the single source of truth: the
 * read-only hints below are derived from it, so a tool can never be described
 * as safe in one place and destructive in another.
 *
 * Getting this wrong is not cosmetic — a client that trusts `readOnlyHint`
 * may auto-approve the call without asking the user, so mislabelling
 * `memos_delete` would hand out silent deletions.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "memos_save",
  "memos_delete",
  "memos_admin",       // register_cube / create_user / validate_cubes mutate state
  "memos_export_wiki", // writes: renders wiki .md files into the target project
]);

/**
 * Tools whose work leaves the local stack: these embed the query or run LLM
 * extraction, so they reach the model relay rather than only Neo4j/Qdrant.
 * Everything else answers from local storage alone.
 */
const REMOTE_TOOLS: ReadonlySet<string> = new Set([
  "memos_save",   // LLM extraction + embedding on the way in
  "memos_search", // embeds the query; with context, adds LLM intent analysis
  "memos_graph",  // mode=related goes through /search, so it embeds too
  "memos_think",  // evidence retrieval goes through /search, embeds the query
]);

export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
}

// A name in either set that no longer exists means a tool was renamed and the
// set was not updated — which would silently downgrade a write tool to
// read-only. Fail at import instead: this is authoring error, not user input,
// so it surfaces on the first build rather than in a client's permission prompt.
for (const name of [...WRITE_TOOLS, ...REMOTE_TOOLS]) {
  if (!(name in toolSchemas)) {
    throw new Error(`tools-registry: '${name}' is annotated but has no schema — rename out of sync`);
  }
}

export const toolAnnotations: Record<string, ToolAnnotations> = Object.fromEntries(
  Object.keys(toolSchemas).map((name) => [
    name,
    {
      readOnlyHint: !WRITE_TOOLS.has(name),
      openWorldHint: REMOTE_TOOLS.has(name),
    },
  ])
);
