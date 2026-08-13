/**
 * Symbolic task canvas — parse and render.
 *
 * A canvas is one Mermaid file. It is the whole truth: there is no parallel
 * JSON sidecar, because two files describing one task drift apart the first
 * time a write fails halfway. The cost of that choice is that the format has to
 * survive a round trip exactly, which is what the tests pin down.
 *
 * The shape borrows the `NNN-Nn` node id from TencentDB Agent Memory, for the
 * reason that made it work there: it is greppable. An id in a canvas, a commit
 * message or a memory body all lead back to the same node.
 *
 * What is ours is the `ref`: an anchor with a scheme, so a node can point at a
 * memory in the graph (`mem:`), a file the harness already offloaded (`file:`),
 * or an inline remark (`note:`). Their design only ever pointed at local files.
 */

// ============================================================================
// Types
// ============================================================================

export const NODE_STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface CanvasNode {
  /** `NNN-Nn`, allocated monotonically and never reused. */
  id: string;
  status: NodeStatus;
  summary: string;
  /** `mem:<uuid>` | `file:<path>` | `note:<text>`, or null. */
  ref: string | null;
}

export interface Canvas {
  /** Three-digit canvas prefix; every node id starts with it. */
  prefix: string;
  taskGoal: string;
  createdTime: string | null;
  updatedTime: string | null;
  nodes: CanvasNode[];
}

/** Cap on a rendered node summary. Long enough to be useful, short enough that
 *  a 20-node canvas still costs a few hundred tokens rather than a few thousand. */
export const SUMMARY_MAX = 120;

const STATUS_SET = new Set<string>(NODE_STATUSES);

// ============================================================================
// slugify
// ============================================================================

const SLUG_MAX = 60;

/**
 * Reduce a title to a filename-safe slug.
 *
 * The whitelist is `[a-z0-9-]` and nothing else — not a blacklist of dangerous
 * characters, because that is the kind of list that is always missing one entry.
 * `.` is outside the whitelist, so `..` cannot survive and traversal is
 * structurally impossible rather than merely checked for.
 *
 * Returns "" when nothing usable remains (a purely CJK title, for instance);
 * callers must have a fallback and must not write a file named "".
 */
export function slugify(input: string): string {
  const lowered = String(input ?? "").toLowerCase();
  const kept = lowered.replace(/[^a-z0-9]+/g, "-");
  const collapsed = kept.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return collapsed.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

// ============================================================================
// escapeLabel
// ============================================================================

/**
 * Make text safe to sit inside a Mermaid `["..."]` label.
 *
 * Mermaid has no escape syntax inside a quoted label, so the only reliable move
 * is to replace the characters that would terminate it with lookalikes. A
 * summary is prose for a human to skim; swapping `"` for `'` costs nothing a
 * reader will miss, and it makes `x"] --> EVIL["pwned` inert.
 *
 * Arrows are neutralised too: a literal `-->` inside a label does not break
 * Mermaid, but it reads as an edge to anyone scanning the file, and to the
 * regex in `parseCanvas` if it ever loosens.
 */
export function escapeLabel(text: string): string {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/-->/g, "→")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ============================================================================
// truncateSummary
// ============================================================================

/**
 * Trim to `max` characters, counting by code point.
 *
 * `String.prototype.slice` counts UTF-16 units, so slicing a string of astral
 * characters mid-pair yields a lone surrogate — which is not a character, and
 * which some JSON consumers reject outright. Spreading into an array iterates
 * code points, so a cut always lands on a boundary.
 */
export function truncateSummary(text: string, max: number = SUMMARY_MAX): string {
  const chars = [...String(text ?? "")];
  if (chars.length <= max) return chars.join("");
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join("");
  return chars.slice(0, max - 1).join("") + "…";
}

// ============================================================================
// allocateNodeId
// ============================================================================

const NODE_ID_RE = /^(\d{3})-N(\d+)$/;

/**
 * Next unused node id for this canvas.
 *
 * Deliberately max+1 rather than filling gaps. A deleted `000-N2` may still be
 * cited by a commit message, a memory body or another node's ref; handing that
 * id to a new node would silently repoint every one of those citations. Ids are
 * cheap, so they are spent rather than recycled.
 */
export function allocateNodeId(canvas: Canvas): string {
  const prefix = /^\d{3}$/.test(canvas.prefix) ? canvas.prefix : "000";
  let max = 0;
  for (const node of canvas.nodes) {
    const m = NODE_ID_RE.exec(node.id);
    if (!m || m[1] !== prefix) continue;
    const n = Number(m[2]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}-N${max + 1}`;
}

// ============================================================================
// renderCanvas
// ============================================================================

/**
 * A ref is carried in its own `<br/>` field and JSON-escaped.
 *
 * Windows paths are the reason: `C:\Users\x` contains backslashes, which JSON
 * escapes and which must come back byte-identical or the anchor stops resolving.
 * Label escaping is for prose; refs get JSON, which is lossless.
 */
function renderRef(ref: string): string {
  return JSON.stringify(ref).slice(1, -1).replace(/"/g, "\\u0022");
}

function parseRef(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

export function renderCanvas(canvas: Canvas): string {
  const meta = {
    taskGoal: canvas.taskGoal,
    createdTime: canvas.createdTime,
    updatedTime: canvas.updatedTime,
    prefix: canvas.prefix,
  };

  const lines: string[] = [
    `%%${JSON.stringify(meta)}%%`,
    "graph LR",
  ];

  for (const node of canvas.nodes) {
    const parts = [
      `status: ${node.status}`,
      `summary: ${escapeLabel(truncateSummary(node.summary))}`,
    ];
    if (node.ref !== null) parts.push(`ref: ${renderRef(node.ref)}`);
    lines.push(`    ${node.id}["${parts.join("<br/>")}"]`);
  }

  // Edges are emitted after all node declarations so that a truncated file
  // still yields every node it contains, rather than losing the tail to a
  // dangling arrow.
  for (let i = 1; i < canvas.nodes.length; i++) {
    lines.push(`    ${canvas.nodes[i - 1].id} --> ${canvas.nodes[i].id}`);
  }

  return lines.join("\n") + "\n";
}

// ============================================================================
// parseCanvas
// ============================================================================

/** Only a line that *starts* with a node declaration opens a node, so an id
 *  mentioned inside a summary is read as prose, which is what it is. */
const NODE_LINE_RE = /^\s*(\d{3}-N\d+)\["([\s\S]*?)"\]\s*$/;

/**
 * Parse a canvas file.
 *
 * Never throws. A canvas is recovered state — it is read at the moment the
 * model has just lost its context, which is the worst possible moment to hand
 * back an exception. A damaged header costs the goal; a damaged line costs that
 * line; everything still parseable is returned.
 */
export function parseCanvas(content: string): Canvas {
  const text = String(content ?? "");

  const canvas: Canvas = {
    prefix: "000",
    taskGoal: "",
    createdTime: null,
    updatedTime: null,
    nodes: [],
  };

  const metaMatch = text.match(/^%%\{[\s\S]*?\}%%/);
  let prefixFromHeader = false;
  if (metaMatch) {
    try {
      const raw = metaMatch[0].slice(2, -2);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      canvas.taskGoal = typeof parsed.taskGoal === "string" ? parsed.taskGoal : "";
      canvas.createdTime = typeof parsed.createdTime === "string" ? parsed.createdTime : null;
      canvas.updatedTime = typeof parsed.updatedTime === "string" ? parsed.updatedTime : null;
      if (typeof parsed.prefix === "string" && /^\d{3}$/.test(parsed.prefix)) {
        canvas.prefix = parsed.prefix;
        prefixFromHeader = true;
      }
    } catch {
      // Corrupt header: the nodes below are still worth having.
    }
  }

  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = NODE_LINE_RE.exec(line);
    if (!m) continue;

    const id = m[1];
    if (seen.has(id)) continue; // first declaration wins
    seen.add(id);

    const body = m[2];
    const fields = body.split("<br/>");
    let status: NodeStatus = "todo";
    let summary = "";
    let ref: string | null = null;

    for (const field of fields) {
      const sep = field.indexOf(":");
      if (sep === -1) continue;
      const key = field.slice(0, sep).trim().toLowerCase();
      const value = field.slice(sep + 1).trim();
      if (key === "status") {
        status = STATUS_SET.has(value) ? (value as NodeStatus) : "todo";
      } else if (key === "summary") {
        summary = value;
      } else if (key === "ref") {
        ref = parseRef(value);
      }
    }

    canvas.nodes.push({ id, status, summary, ref });
  }

  if (!prefixFromHeader && canvas.nodes.length > 0) {
    const m = NODE_ID_RE.exec(canvas.nodes[0].id);
    if (m) canvas.prefix = m[1];
  }

  return canvas;
}

// ============================================================================
// Summary helpers
// ============================================================================

export interface CanvasCounts {
  done: number;
  doing: number;
  todo: number;
  blocked: number;
}

export function countByStatus(canvas: Canvas): CanvasCounts {
  const counts: CanvasCounts = { done: 0, doing: 0, todo: 0, blocked: 0 };
  for (const node of canvas.nodes) counts[node.status] += 1;
  return counts;
}

/** One-line digest for the progressive-disclosure index: enough to decide
 *  whether to open the canvas, not enough to be worth injecting wholesale. */
export function formatCanvasHeadline(canvas: Canvas): string {
  const c = countByStatus(canvas);
  const goal = canvas.taskGoal || "(no goal recorded)";
  return `${goal} — ${c.done} done / ${c.doing} doing / ${c.todo} todo${c.blocked > 0 ? ` / ${c.blocked} blocked` : ""}`;
}
