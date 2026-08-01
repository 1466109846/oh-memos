/**
 * Parameter contract — disclose arguments the schema silently discarded.
 *
 * zod strips keys it does not declare. That is a sane default for a validator
 * and a bad one for a memory server: a call carrying `path="/mnt/g/foo"`
 * instead of `project_path` validates cleanly, loses the key, falls back to the
 * default cube, searches the wrong project, and returns nothing. The model then
 * reads that empty result as "this project has no memories" — a wrong answer
 * with no error anywhere in the chain. (This is how `dev_cube` accumulated
 * memories belonging to other projects.)
 *
 * So: capture the argument keys as they arrive at the transport, before zod
 * touches them, and say plainly which ones were dropped.
 *
 * The call is never rejected. An unknown key has always been accepted, and
 * turning a recoverable mistake into a hard failure trades a slightly wrong
 * answer for no answer at all. Disclosure lets the model correct itself on the
 * next call; rejection just ends the conversation with the memory store.
 */

import { z } from "zod";

import { toolSchemas } from "../tools-registry.js";
import { levenshteinDistance } from "../keyword-enhancer.js";

// ============================================================================
// Declared keys — derived from the schemas, never hand-copied
// ============================================================================

const DECLARED_KEYS: Record<string, string[]> = Object.fromEntries(
  Object.entries(toolSchemas).map(([name, schema]) => [
    name,
    Object.keys((schema.inputSchema as z.ZodObject<z.ZodRawShape>).shape),
  ])
);

/** `project_path` → `projectpath`, so camelCase and case slips still match. */
function normalize(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Words that mean the right thing but are not the right key. Spelling distance
 * alone would not connect `cwd` to `project_path`, and these are the misses
 * seen in practice — a caller reaching for the concept, not fumbling the word.
 */
const SEMANTIC_ALIASES: Record<string, string[]> = {
  project_path: ["path", "cwd", "dir", "directory", "folder", "root", "project", "projectdir", "projectroot", "workdir", "workingdirectory"],
  cube_id: ["cube", "cubename", "memcube", "memcubeid", "cubeid", "namespace"],
  query: ["q", "text", "search", "searchquery", "keyword", "keywords", "prompt"],
  memory_type: ["type", "memtype", "kind", "category"],
  memory_id: ["id", "memid", "nodeid"],
  top_k: ["topk", "k", "count", "n", "max", "maxresults"],
  content: ["memory", "body", "message", "note"],
  max_depth: ["depth", "hops", "maxhops"],
  mode: ["kind", "graphmode", "graph_mode"],
  action: ["op", "operation", "command", "subcommand"],
};

/** Reverse index: normalized alias → the key it probably meant. */
const ALIAS_TO_KEY: Record<string, string> = {};
for (const [key, aliases] of Object.entries(SEMANTIC_ALIASES)) {
  for (const alias of aliases) ALIAS_TO_KEY[normalize(alias)] = key;
}

/**
 * Best guess at what an undeclared key was reaching for, or null.
 * Only ever suggests a key the tool actually declares.
 */
function suggestFor(unknownKey: string, declared: string[]): string | null {
  const norm = normalize(unknownKey);

  // 1. Same key, different spelling convention (projectPath, Cube_Id, …).
  const exact = declared.find((d) => normalize(d) === norm);
  if (exact) return exact;

  // 2. Same concept, different word (path → project_path).
  const alias = ALIAS_TO_KEY[norm];
  if (alias && declared.includes(alias)) return alias;

  // 3. Plain typo. Keep the threshold tight — a loose match that points at the
  //    wrong parameter is worse than saying nothing, because the caller will
  //    act on it.
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const d of declared) {
    const distance = levenshteinDistance(norm, normalize(d));
    if (distance < bestDistance) {
      best = d;
      bestDistance = distance;
    }
  }
  const tolerance = norm.length <= 4 ? 1 : 2;
  return best !== null && bestDistance <= tolerance ? best : null;
}

// ============================================================================
// Raw argument capture
// ============================================================================

/**
 * Keyed by JSON-RPC request id, so a warning can never be attached to a
 * different call than the one that earned it — clients are free to pipeline.
 * Entries are consumed on read; the cap is a backstop for the case where a
 * request is recorded but never dispatched (validation rejected it upstream),
 * which would otherwise leak an entry per failed call.
 */
const rawArgKeys = new Map<string, string[]>();
const MAX_TRACKED = 64;

export function recordRawArgKeys(requestId: unknown, args: unknown): void {
  if (requestId === undefined || requestId === null) return;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return;

  if (rawArgKeys.size >= MAX_TRACKED) {
    const oldest = rawArgKeys.keys().next();
    if (!oldest.done) rawArgKeys.delete(oldest.value);
  }
  rawArgKeys.set(String(requestId), Object.keys(args as Record<string, unknown>));
}

function takeRawArgKeys(requestId: unknown): string[] | undefined {
  if (requestId === undefined || requestId === null) return undefined;
  const id = String(requestId);
  const keys = rawArgKeys.get(id);
  rawArgKeys.delete(id);
  return keys;
}

// ============================================================================
// Contract check
// ============================================================================

export interface ArgContractResult {
  /** Keys the caller sent that the schema does not declare (and so discarded). */
  ignored: string[];
  /** Whether any ignored key looks like it was meant to route the cube. */
  affectsRouting: boolean;
  /** Human-readable warning, or null when everything was declared. */
  warning: string | null;
}

const ROUTING_KEYS = new Set(["project_path", "cube_id"]);

export function checkArgContract(toolName: string, requestId: unknown): ArgContractResult {
  const none: ArgContractResult = { ignored: [], affectsRouting: false, warning: null };

  const sent = takeRawArgKeys(requestId);
  if (!sent || sent.length === 0) return none;

  const declared = DECLARED_KEYS[toolName];
  if (!declared) return none; // unknown tool — dispatch reports that itself

  const ignored = sent.filter((k) => !declared.includes(k));
  if (ignored.length === 0) return none;

  const lines: string[] = [
    `⚠️ [IGNORED_ARGS] ${ignored.length === 1 ? "One argument was" : `${ignored.length} arguments were`} not recognised by \`${toolName}\` and had no effect:`,
    "",
  ];

  let affectsRouting = false;
  for (const key of ignored) {
    const suggestion = suggestFor(key, declared);
    if (suggestion && ROUTING_KEYS.has(suggestion)) affectsRouting = true;
    lines.push(
      suggestion
        ? `  • \`${key}\` — did you mean \`${suggestion}\`?`
        : `  • \`${key}\` — not a parameter of this tool`
    );
  }

  lines.push("", `  Accepted parameters: ${declared.map((d) => `\`${d}\``).join(", ")}`);

  if (affectsRouting) {
    lines.push(
      "",
      "  That argument decides which cube is searched. Because it was dropped, this",
      "  call used the default cube — so an empty or unfamiliar result here says",
      "  nothing about your project's memories. Retry with the correct parameter",
      "  before concluding anything.",
    );
  }

  return { ignored, affectsRouting, warning: lines.join("\n") };
}
