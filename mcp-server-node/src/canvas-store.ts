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

import { parseCanvas, renderCanvas, slugify, type Canvas } from "./canvas-format.js";

export class CanvasPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasPathError";
  }
}

const CANVAS_DIR = "canvas";
const CANVAS_EXT = ".mmd";

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
export function canvasPath(cubesDir: string, cubeId: string, name: string): string {
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
      `(allowed: letters, digits, hyphen)`
    );
  }
  // slugify is lossy, so a name that only differs by stripped characters would
  // silently collide with, or redirect to, another canvas. Refuse instead.
  if (slug !== rawName.toLowerCase()) {
    const looksLikePath = /[\\/]|\.\./.test(rawName);
    if (looksLikePath) {
      throw new CanvasPathError(
        `canvas name must be a bare name, not a path: ${JSON.stringify(rawName)}`
      );
    }
  }

  const dir = resolve(cubesDir, rawCube, CANVAS_DIR);
  const full = resolve(dir, `${slug}${CANVAS_EXT}`);

  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
  if (!full.startsWith(dirWithSep) || basename(full) !== `${slug}${CANVAS_EXT}`) {
    throw new CanvasPathError(`resolved path escapes the canvas directory: ${full}`);
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
export function loadCanvas(cubesDir: string, cubeId: string, name: string): Canvas | null {
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
  canvas: Canvas
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
  return path;
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
      entries.push({ name, path, canvas: parseCanvas(readFileSync(path, "utf8")) });
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

const PREFIX_RE = /^(\d{3})/;

/**
 * Next unused three-digit canvas prefix, or null once 999 is taken.
 *
 * Max+1, never gap-filling, for the same reason node ids are not recycled: a
 * prefix appears inside every node id it minted, and reissuing it would make
 * two canvases' ids ambiguous. Returning null instead of wrapping keeps the
 * failure visible — a caller that has 1000 canvases in one cube has a different
 * problem than a naming collision.
 */
export function nextPrefix(cubesDir: string, cubeId: string): string | null {
  let max = -1;
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
