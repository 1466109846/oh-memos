/**
 * Symbolic task canvas — filesystem storage.
 *
 * Canvases live at `{cubesDir}/{cube_id}/canvas/{name}.mmd`, beside the cube
 * whose task they describe. They are deliberately *not* written into Neo4j or
 * Qdrant: a canvas is short-term session state that changes many times an hour,
 * and paying an embedding round trip per status flip would be absurd. Long-term
 * facts go through `memos_save`; the canvas points at them with a `mem:` ref.
 *
 * Two properties matter here, and both are about failing safely rather than
 * failing loudly:
 *
 * 1. Every path is built by `canvasPath`, which rejects anything that would
 *    escape the canvas directory. `cube_id` is derived from a caller-supplied
 *    project path, so it is untrusted input too — not just the canvas name.
 *
 * 2. Writes are atomic (temp file + rename). A canvas is read at precisely the
 *    moment context was lost, so a half-written file is worse than a stale one.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import {
  parseCanvas,
  renderCanvas,
  slugify,
  type Canvas,
} from "./canvas-format.js";

export class CanvasPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasPathError";
  }
}

const CANVAS_DIR = "canvas";
const CANVAS_EXT = ".mmd";

/**
 * Highest prefix ever issued in this cube, kept outside the canvas files.
 *
 * Without it, `nextPrefix` derives the watermark from the files that happen to
 * exist, and deleting the newest canvas hands its prefix to the next one — which
 * is exactly the id ambiguity `nextPrefix` refuses to create. The name starts
 * with a dot and does not end in `.mmd`, so `slugify` can never mint it and
 * `listCanvases` never reads it as a canvas.
 */
const PREFIX_HWM_FILE = ".prefix-hwm";

/** Leading three digits of a canvas name — the prefix it minted its ids from. */
const PREFIX_RE = /^(\d{3})/;

/** `cube_id` is machine-derived (`detectCubeFromPath`), so this is a shape check
 *  rather than a sanitiser — a value that does not look like a cube id is a bug
 *  upstream, and guessing at what it meant would hide it. */
const CUBE_ID_RE = /^[a-z0-9_]+$/;

// ============================================================================
// Path construction
// ============================================================================

/**
 * Resolve a canvas file path, or throw.
 *
 * The name is passed through `slugify`, whose whitelist excludes `.`, `/` and
 * `\` — so `..`, absolute paths and nested segments cannot survive it. The
 * post-resolve containment check is a second, independent line: if a future
 * change to slugify ever lets something through, this still catches it.
 */
export function canvasPath(
  cubesDir: string,
  cubeId: string,
  name: string,
): string {
  const rawName = String(name ?? "");
  const rawCube = String(cubeId ?? "");

  // A NUL truncates a path in some syscalls, so `a\u0000.mmd` could end up
  // addressing `a`. slugify drops it anyway; reject explicitly rather than
  // quietly accepting a name that was plainly an attack.
  if (rawName.includes("\u0000") || rawCube.includes("\u0000")) {
    throw new CanvasPathError("canvas name must not contain a NUL byte");
  }
  if (!CUBE_ID_RE.test(rawCube)) {
    throw new CanvasPathError(`invalid cube_id: ${JSON.stringify(rawCube)}`);
  }

  const slug = slugify(rawName);
  if (!slug) {
    throw new CanvasPathError(
      `canvas name ${JSON.stringify(rawName)} contains no usable characters ` +
        `(allowed: letters, digits, hyphen)`,
    );
  }
  // slugify is lossy, so a name that only differs by stripped characters would
  // silently collide with, or redirect to, another canvas. Refuse instead.
  if (slug !== rawName.toLowerCase()) {
    const looksLikePath = /[\\/]|\.\./.test(rawName);
    if (looksLikePath) {
      throw new CanvasPathError(
        `canvas name must be a bare name, not a path: ${JSON.stringify(rawName)}`,
      );
    }
  }

  const dir = resolve(cubesDir, rawCube, CANVAS_DIR);
  const full = resolve(dir, `${slug}${CANVAS_EXT}`);

  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
  if (
    !full.startsWith(dirWithSep) ||
    basename(full) !== `${slug}${CANVAS_EXT}`
  ) {
    throw new CanvasPathError(
      `resolved path escapes the canvas directory: ${full}`,
    );
  }

  return full;
}

function canvasDirFor(cubesDir: string, cubeId: string): string | null {
  if (!CUBE_ID_RE.test(String(cubeId ?? ""))) return null;
  return resolve(cubesDir, cubeId, CANVAS_DIR);
}

// ============================================================================
// Load / save
// ============================================================================

/** Returns null when the canvas does not exist. A damaged file yields an empty
 *  canvas rather than an exception — see `parseCanvas`. */
export function loadCanvas(
  cubesDir: string,
  cubeId: string,
  name: string,
): Canvas | null {
  const path = canvasPath(cubesDir, cubeId, name);
  if (!existsSync(path)) return null;
  try {
    return parseCanvas(readFileSync(path, "utf8"));
  } catch {
    return null; // unreadable (permissions, race) — treat as absent
  }
}

/** Writes atomically and returns the path written. */
export function saveCanvas(
  cubesDir: string,
  cubeId: string,
  name: string,
  canvas: Canvas,
): string {
  const path = canvasPath(cubesDir, cubeId, name);
  const dir = resolve(cubesDir, cubeId, CANVAS_DIR);
  mkdirSync(dir, { recursive: true });

  // Same directory as the target, so the rename cannot cross a filesystem
  // boundary and degrade into a non-atomic copy.
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, renderCanvas(canvas), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best effort: the write already failed, and masking that error with a
      // cleanup error would lose the useful one
    }
    throw err;
  }

  // After the rename, so a failed write never advances the watermark. Recorded
  // on every save rather than only on create: it is idempotent, and a cube whose
  // watermark was lost recovers it on the next update to any canvas.
  const m = PREFIX_RE.exec(name);
  if (m) bumpPrefixHwm(cubesDir, cubeId, m[1]);

  return path;
}

/**
 * Remove a canvas file. Returns false when it was not there to begin with.
 *
 * Deliberately not atomic and deliberately not a soft delete. A canvas is
 * short-term state whose whole purpose is to be discarded once the task closes;
 * a trash directory would just accumulate the files this exists to remove. The
 * decision about whether losing this particular canvas is acceptable belongs to
 * the caller, which is why the handler asks before reaching this function.
 *
 * `canvasPath` runs first, so a traversal-shaped name throws rather than
 * unlinking something outside the canvas directory.
 *
 * The watermark is raised before the unlink, because the file is the only other
 * record of the prefix and it is about to stop existing. A cube written before
 * the watermark existed has none, so without this the delete would leave no
 * trace of the prefix at all and `nextPrefix` would reissue it.
 */
export function deleteCanvas(
  cubesDir: string,
  cubeId: string,
  name: string,
): boolean {
  const path = canvasPath(cubesDir, cubeId, name);
  if (!existsSync(path)) return false;

  const m = PREFIX_RE.exec(name);
  if (m) bumpPrefixHwm(cubesDir, cubeId, m[1]);

  unlinkSync(path);
  return true;
}

// ============================================================================
// Listing
// ============================================================================

export interface CanvasEntry {
  /** Filename without the extension — the handle callers pass back in. */
  name: string;
  path: string;
  canvas: Canvas;
}

/**
 * Every canvas in a cube, sorted by name.
 *
 * Returns [] rather than throwing for a missing directory or a bad cube id:
 * this feeds the context-resume index, which must never be the thing that
 * breaks a session recovery.
 */
export function listCanvases(cubesDir: string, cubeId: string): CanvasEntry[] {
  const dir = canvasDirFor(cubesDir, cubeId);
  if (!dir || !existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const entries: CanvasEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(CANVAS_EXT)) continue;
    const name = file.slice(0, -CANVAS_EXT.length);
    const path = join(dir, file);
    try {
      entries.push({
        name,
        path,
        canvas: parseCanvas(readFileSync(path, "utf8")),
      });
    } catch {
      continue; // unreadable file should not hide the readable ones
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ============================================================================
// Prefix allocation
// ============================================================================

function prefixHwmPath(cubesDir: string, cubeId: string): string | null {
  const dir = canvasDirFor(cubesDir, cubeId);
  return dir ? join(dir, PREFIX_HWM_FILE) : null;
}

/**
 * Highest prefix ever issued, or -1 when there is no usable record.
 *
 * Any unreadable or out-of-range value reads as -1 rather than throwing: losing
 * the watermark degrades allocation back to filesystem-derived, which is a
 * weaker guarantee but not a broken one.
 */
function readPrefixHwm(cubesDir: string, cubeId: string): number {
  const path = prefixHwmPath(cubesDir, cubeId);
  if (!path || !existsSync(path)) return -1;
  try {
    const n = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(n) && n >= 0 && n <= 999 ? n : -1;
  } catch {
    return -1;
  }
}

/** Raise the watermark to `prefix` if that is higher. Never lowers it. */
function bumpPrefixHwm(cubesDir: string, cubeId: string, prefix: string): void {
  const path = prefixHwmPath(cubesDir, cubeId);
  if (!path) return;
  const n = Number(prefix);
  if (!Number.isInteger(n) || n < 0 || n > 999) return;
  if (n <= readPrefixHwm(cubesDir, cubeId)) return;
  try {
    writeFileSync(path, String(n), "utf8");
  } catch {
    // Best effort. A canvas that saved but failed to record its prefix is
    // still a usable canvas; refusing the save would be the worse trade.
  }
}

/**
 * Next unused three-digit canvas prefix, or null once 999 is taken.
 *
 * Max+1, never gap-filling, for the same reason node ids are not recycled: a
 * prefix appears inside every node id it minted, and reissuing it would make
 * two canvases' ids ambiguous. Returning null instead of wrapping keeps the
 * failure visible — a caller that has 1000 canvases in one cube has a different
 * problem than a naming collision.
 *
 * The watermark is consulted alongside the files on disk because `deleteCanvas`
 * exists: deriving the maximum from surviving files alone would hand a deleted
 * canvas's prefix to the next one, which is the ambiguity this function is
 * written to avoid. Files are still scanned so that a cube predating the
 * watermark, or one whose watermark was lost, allocates correctly.
 */
export function nextPrefix(cubesDir: string, cubeId: string): string | null {
  let max = readPrefixHwm(cubesDir, cubeId);
  for (const entry of listCanvases(cubesDir, cubeId)) {
    const m = PREFIX_RE.exec(entry.name);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  const next = max + 1;
  if (next > 999) return null;
  return String(next).padStart(3, "0");
}
