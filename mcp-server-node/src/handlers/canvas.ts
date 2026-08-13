/**
 * memos_canvas — symbolic short-term task memory.
 *
 * The long-term side of this server (memories, graph, wiki) answers "what do we
 * know". The canvas answers "where was I", which is a different question with a
 * different lifetime: it changes several times an hour, it is worthless a week
 * later, and it must survive exactly one event — context compaction.
 *
 * Why a Mermaid file rather than more memories:
 *
 * - A memory costs an LLM extraction and an embedding on write. A status flip
 *   from doing→done deserves neither.
 * - The value of the canvas is its *topology* — which step follows which, and
 *   which one is stuck. Flat memory rows lose exactly that.
 * - `node_id` is greppable, so a node can be cited from a commit message or a
 *   memory body and still be found later.
 *
 * The `ref` field is where the two halves meet: a node points at durable
 * evidence with `mem:<uuid>` (a memory in the graph), `file:<path>` (a file the
 * harness already offloaded), or `note:<text>`. Abstraction stays cheap, and the
 * path back to evidence stays open.
 *
 * One thing this deliberately does not do: claim a token saving. That claim
 * belongs to designs that intercept and replace tool output before the model
 * sees it, which a Claude Code hook cannot do — PostToolUse can add context but
 * not rewrite a result. What is on offer here is task state that survives
 * compaction, and anchors that make a summary checkable.
 */

import { MEMOS_CUBES_DIR } from "../config.js";
import {
  NODE_STATUSES,
  allocateNodeId,
  countByStatus,
  formatCanvasHeadline,
  slugify,
  truncateSummary,
  type Canvas,
  type CanvasNode,
  type NodeStatus,
} from "../canvas-format.js";
import {
  CanvasPathError,
  listCanvases,
  loadCanvas,
  nextPrefix,
  saveCanvas,
} from "../canvas-store.js";
import type { TextContent } from "../types.js";
import {
  ERR_PARAM_INVALID,
  ERR_PARAM_MISSING,
  ERR_OPERATION_FAILED,
  errorResponse,
  getCubeIdFromArgs,
} from "./utils.js";

const STATUS_LIST = NODE_STATUSES.join(", ");

/** Ceiling on nodes in one canvas. Past this the canvas has stopped being a
 *  symbol and become a log, which is what the refs are for. */
const MAX_NODES = 40;

function statusIcon(status: NodeStatus): string {
  switch (status) {
    case "done": return "✓";
    case "doing": return "▶";
    case "blocked": return "✗";
    default: return "○";
  }
}

function parseStatus(raw: unknown): NodeStatus | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return (NODE_STATUSES as readonly string[]).includes(value)
    ? (value as NodeStatus)
    : null;
}

/** Refs must carry a scheme, so a bare string cannot be mistaken for a path
 *  that happens to exist. Existence is not checked: a `mem:` id lives in the
 *  graph, not on disk, and a `file:` may be written moments later. */
function validateRef(raw: unknown): { ok: true; ref: string | null } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, ref: null };
  const value = String(raw).trim();
  if (/^(mem|file|note):/.test(value)) return { ok: true, ref: value };
  return {
    ok: false,
    reason:
      `ref must start with a scheme — \`mem:<memory_id>\`, \`file:<path>\` or \`note:<text>\`. ` +
      `Got: ${JSON.stringify(value.slice(0, 60))}`,
  };
}

function pathErrorResponse(err: unknown): TextContent[] {
  if (err instanceof CanvasPathError) {
    return errorResponse(err.message, ERR_PARAM_INVALID, [
      "`name` must be a bare canvas name (letters, digits, hyphen) — not a path",
      'List existing canvases with `memos_canvas(action="list")`',
    ]);
  }
  return errorResponse(
    `Canvas operation failed: ${String(err)}`,
    ERR_OPERATION_FAILED,
    ["Check that MEMOS_CUBES_DIR is writable"]
  );
}

// ============================================================================
// Rendering
// ============================================================================

function renderCanvasView(name: string, path: string, canvas: Canvas): string {
  const counts = countByStatus(canvas);
  const lines: string[] = [
    `## 🗺️ Canvas: ${name}`,
    "",
    `**Goal**: ${canvas.taskGoal || "(none recorded)"}`,
    `**Progress**: ${counts.done} done · ${counts.doing} doing · ${counts.todo} todo` +
      (counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""),
    `**File**: ${path}`,
    "",
  ];

  if (canvas.nodes.length === 0) {
    lines.push(
      "_No nodes yet._",
      "",
      `Add one: \`memos_canvas(action="update", name="${name}", summary="<step>")\``
    );
    return lines.join("\n");
  }

  for (const node of canvas.nodes) {
    lines.push(`${statusIcon(node.status)} \`${node.id}\` ${node.summary}`);
    if (node.ref) lines.push(`    ↳ ${node.ref}`);
  }

  lines.push(
    "",
    "---",
    "`mem:` refs open with `memos_get(memory_id=...)`; `file:` refs with Read.",
  );
  return lines.join("\n");
}

// ============================================================================
// Actions
// ============================================================================

function actionOpen(cubeId: string, args: Record<string, unknown>): TextContent[] {
  const goal = String(args.goal ?? "").trim();
  if (!goal) {
    return errorResponse("`goal` is required to open a canvas", ERR_PARAM_MISSING, [
      'memos_canvas(action="open", goal="<what this task is>", project_path="<cwd>")',
    ]);
  }

  const prefix = nextPrefix(MEMOS_CUBES_DIR, cubeId);
  if (prefix === null) {
    return errorResponse(
      `Cube '${cubeId}' already holds 1000 canvases (000-999)`,
      ERR_OPERATION_FAILED,
      ["Remove finished canvas files from the cube's canvas/ directory"]
    );
  }

  // The goal supplies the slug; a goal with no ASCII (a Chinese title, say)
  // yields none, so fall back to the prefix rather than writing a nameless file.
  const goalSlug = slugify(goal);
  const name = goalSlug ? `${prefix}-${goalSlug}` : `${prefix}-task`;

  const now = new Date().toISOString();
  const canvas: Canvas = {
    prefix,
    taskGoal: goal,
    createdTime: now,
    updatedTime: now,
    nodes: [],
  };

  try {
    const path = saveCanvas(MEMOS_CUBES_DIR, cubeId, name, canvas);
    return [{
      type: "text",
      text: [
        renderCanvasView(name, path, canvas),
        "",
        `Canvas \`${name}\` created. Node ids will be \`${prefix}-N1\`, \`${prefix}-N2\`, …`,
      ].join("\n"),
    }];
  } catch (err) {
    return pathErrorResponse(err);
  }
}

function actionUpdate(cubeId: string, args: Record<string, unknown>): TextContent[] {
  const name = String(args.name ?? "").trim();
  if (!name) {
    return errorResponse("`name` is required", ERR_PARAM_MISSING, [
      'Find it with `memos_canvas(action="list")`',
    ]);
  }

  let canvas: Canvas | null;
  try {
    canvas = loadCanvas(MEMOS_CUBES_DIR, cubeId, name);
  } catch (err) {
    return pathErrorResponse(err);
  }

  if (canvas === null) {
    return errorResponse(`Canvas '${name}' not found in cube '${cubeId}'`, ERR_PARAM_INVALID, [
      'List canvases: `memos_canvas(action="list", project_path="<cwd>")`',
      'Create one: `memos_canvas(action="open", goal="...", project_path="<cwd>")`',
    ]);
  }

  const nodeId = String(args.node_id ?? "").trim();
  const summaryRaw = args.summary;
  const statusRaw = args.status;

  const refCheck = validateRef(args.ref);
  if (!refCheck.ok) return errorResponse(refCheck.reason, ERR_PARAM_INVALID);

  let touched: CanvasNode;

  if (nodeId) {
    // Update an existing node.
    const existing = canvas.nodes.find((n) => n.id === nodeId);
    if (!existing) {
      return errorResponse(
        `Node '${nodeId}' not found on canvas '${name}'`,
        ERR_PARAM_INVALID,
        [
          `Existing nodes: ${canvas.nodes.map((n) => n.id).join(", ") || "(none)"}`,
          "Omit `node_id` to append a new node",
        ]
      );
    }
    const status = statusRaw === undefined ? existing.status : parseStatus(statusRaw);
    if (status === null) {
      return errorResponse(
        `Invalid status: ${JSON.stringify(String(statusRaw))}`,
        ERR_PARAM_INVALID,
        [`Valid: ${STATUS_LIST}`]
      );
    }
    existing.status = status;
    if (summaryRaw !== undefined) existing.summary = truncateSummary(String(summaryRaw));
    if (args.ref !== undefined) existing.ref = refCheck.ref;
    touched = existing;
  } else {
    // Append a new node.
    if (summaryRaw === undefined || String(summaryRaw).trim() === "") {
      return errorResponse(
        "`summary` is required when appending a node",
        ERR_PARAM_MISSING,
        ['memos_canvas(action="update", name="...", summary="<step>", status="doing")']
      );
    }
    if (canvas.nodes.length >= MAX_NODES) {
      return errorResponse(
        `Canvas '${name}' already has ${MAX_NODES} nodes`,
        ERR_OPERATION_FAILED,
        [
          "A canvas this long has become a log. Close it out and open a new one",
          "Move detail into refs (`mem:` / `file:`) instead of more nodes",
        ]
      );
    }
    const status = statusRaw === undefined ? "todo" : parseStatus(statusRaw);
    if (status === null) {
      return errorResponse(
        `Invalid status: ${JSON.stringify(String(statusRaw))}`,
        ERR_PARAM_INVALID,
        [`Valid: ${STATUS_LIST}`]
      );
    }
    touched = {
      id: allocateNodeId(canvas),
      status,
      summary: truncateSummary(String(summaryRaw)),
      ref: refCheck.ref,
    };
    canvas.nodes.push(touched);
  }

  canvas.updatedTime = new Date().toISOString();

  try {
    const path = saveCanvas(MEMOS_CUBES_DIR, cubeId, name, canvas);
    return [{
      type: "text",
      text: [
        `${statusIcon(touched.status)} \`${touched.id}\` ${touched.summary}` +
          (touched.ref ? `\n    ↳ ${touched.ref}` : ""),
        "",
        renderCanvasView(name, path, canvas),
      ].join("\n"),
    }];
  } catch (err) {
    return pathErrorResponse(err);
  }
}

function actionShow(cubeId: string, args: Record<string, unknown>): TextContent[] {
  const name = String(args.name ?? "").trim();
  if (!name) {
    return errorResponse("`name` is required", ERR_PARAM_MISSING, [
      'List canvases: `memos_canvas(action="list", project_path="<cwd>")`',
    ]);
  }

  let canvas: Canvas | null;
  try {
    canvas = loadCanvas(MEMOS_CUBES_DIR, cubeId, name);
  } catch (err) {
    return pathErrorResponse(err);
  }

  if (canvas === null) {
    return errorResponse(`Canvas '${name}' not found in cube '${cubeId}'`, ERR_PARAM_INVALID, [
      'List canvases: `memos_canvas(action="list", project_path="<cwd>")`',
    ]);
  }

  // Recompute the path for display only; load already proved it resolves.
  const entry = listCanvases(MEMOS_CUBES_DIR, cubeId).find((e) => e.name === name);
  return [{ type: "text", text: renderCanvasView(name, entry?.path ?? name, canvas) }];
}

function actionList(cubeId: string): TextContent[] {
  const entries = listCanvases(MEMOS_CUBES_DIR, cubeId);

  if (entries.length === 0) {
    return [{
      type: "text",
      text: [
        `## 🗺️ Canvases: ${cubeId}`,
        "",
        "No canvases yet.",
        "",
        'Open one: `memos_canvas(action="open", goal="<task>", project_path="<cwd>")`',
      ].join("\n"),
    }];
  }

  // Unfinished first: after a compaction the open work is the only part that
  // still matters.
  const ranked = [...entries].sort((a, b) => {
    const aOpen = countByStatus(a.canvas).doing + countByStatus(a.canvas).todo;
    const bOpen = countByStatus(b.canvas).doing + countByStatus(b.canvas).todo;
    if (aOpen !== bOpen) return bOpen - aOpen;
    return (b.canvas.updatedTime ?? "").localeCompare(a.canvas.updatedTime ?? "");
  });

  const lines = [`## 🗺️ Canvases: ${cubeId} (${entries.length})`, ""];
  for (const entry of ranked) {
    lines.push(`- \`${entry.name}\` — ${formatCanvasHeadline(entry.canvas)}`);
  }
  lines.push("", 'Open one with `memos_canvas(action="show", name="<name>")`.');

  return [{ type: "text", text: lines.join("\n") }];
}

// ============================================================================
// Dispatch
// ============================================================================

export async function handleMemosCanvas(
  arguments_: Record<string, unknown>
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const action = String(arguments_.action ?? "").trim().toLowerCase();

  switch (action) {
    case "open":
      return actionOpen(cubeId, arguments_);
    case "update":
      return actionUpdate(cubeId, arguments_);
    case "show":
      return actionShow(cubeId, arguments_);
    case "list":
      return actionList(cubeId);
    default:
      return errorResponse(
        `Unknown canvas action: ${String(arguments_.action ?? "(none)")}`,
        ERR_PARAM_INVALID,
        ["Valid actions: open, update, show, list"]
      );
  }
}

/**
 * Active-canvas digest for `memos_context_resume`.
 *
 * Headlines only — a few dozen tokens for the whole index. Injecting canvas
 * bodies here would rebuild the context bloat the canvas exists to avoid; the
 * model opens what it needs with `show`. Never throws: this runs during session
 * recovery, and a canvas problem must not break that.
 */
export function summarizeActiveCanvases(cubeId: string, limit = 3): string[] {
  let entries;
  try {
    entries = listCanvases(MEMOS_CUBES_DIR, cubeId);
  } catch {
    return [];
  }

  const active = entries.filter((e) => {
    const c = countByStatus(e.canvas);
    return c.doing + c.todo + c.blocked > 0;
  });
  if (active.length === 0) return [];

  active.sort((a, b) => (b.canvas.updatedTime ?? "").localeCompare(a.canvas.updatedTime ?? ""));

  const lines = [`**Active canvases** (${active.length}):`, ""];
  for (const entry of active.slice(0, limit)) {
    lines.push(`- \`${entry.name}\` — ${formatCanvasHeadline(entry.canvas)}`);
  }
  if (active.length > limit) {
    lines.push(`- …and ${active.length - limit} more`);
  }
  lines.push("", 'Open one: `memos_canvas(action="show", name="<name>")`', "");
  return lines;
}
