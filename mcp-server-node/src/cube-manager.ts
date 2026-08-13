/**
 * MemOS MCP Server Cube Management Module
 *
 * Handles cube discovery, config, and registration.
 */

import * as fs from "fs";
import * as path from "path";

import {
  MEMOS_URL,
  MEMOS_USER,
  MEMOS_DEFAULT_CUBE,
  MEMOS_CUBES_DIR,
  MEMOS_TIMEOUT_STARTUP,
  REGISTRATION_RETRY_INTERVAL,
  registeredCubes,
  lastRegistrationAttempt,
  logger,
  isDefaultCubeFromEnv,
} from "./config.js";
import { detectCubeFromPath } from "./keyword-enhancer.js";
import { fetchWithTimeout } from "./api-client.js";
import type { CubeInfo, CubeConfig } from "./types.js";

// ============================================================================
// Windows/WSL Path Conversion
// ============================================================================

/**
 * Convert Windows path to WSL/Linux path for local file access.
 * e.g. "G:\\test\\MemOS\\data" → "/mnt/g/test/MemOS/data"
 *
 * Only meaningful when this process can actually reach the drive through
 * /mnt/<drive> — i.e. we are running inside WSL. On native Windows Node a
 * "/mnt/g/..." string is not absolute: it resolves against the current drive,
 * so fs.mkdirSync happily creates C:\mnt\g\... (or G:\mnt\g\... depending on
 * cwd) and every subsequent read/write silently targets that phantom tree
 * while the API keeps using the real Windows path. Return the path untouched
 * on win32 so both sides address the same directory.
 */
function toLocalPath(p: string): string {
  // Native Windows: Windows paths are already the local paths.
  if (process.platform === "win32") return p;
  // Already a Unix path
  if (p.startsWith("/")) return p;
  // Windows absolute path: "G:\..." or "G:/..."
  const winMatch = p.match(/^([A-Za-z]):[/\\](.*)/);
  if (winMatch) {
    const drive = winMatch[1].toLowerCase();
    const rest = winMatch[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }
  return p;
}

// ============================================================================
// Cube Discovery
// ============================================================================

export function getCubesBaseDir(): string {
  const cubesDir = MEMOS_CUBES_DIR;
  if (cubesDir.endsWith(MEMOS_DEFAULT_CUBE)) {
    return path.dirname(cubesDir);
  }
  return cubesDir;
}

export function getLocalCubesBaseDir(): string {
  return toLocalPath(getCubesBaseDir());
}

export function listAvailableCubes(): CubeInfo[] {
  const available: CubeInfo[] = [];
  const cubesDirLocal = getLocalCubesBaseDir();

  if (!fs.existsSync(cubesDirLocal) || !fs.statSync(cubesDirLocal).isDirectory()) {
    logger.warning(`Cubes directory does not exist: ${cubesDirLocal}`);
    return available;
  }

  try {
    const items = fs.readdirSync(cubesDirLocal);
    for (const item of items) {
      const itemPath = path.join(cubesDirLocal, item);
      const configPath = path.join(itemPath, "config.json");
      if (
        fs.existsSync(itemPath) &&
        fs.statSync(itemPath).isDirectory() &&
        fs.existsSync(configPath)
      ) {
        available.push({ id: item, path: itemPath });
      }
    }
  } catch (err) {
    logger.warning(`Error scanning cubes directory: ${err}`);
  }

  return available;
}

export function getCubePath(cubeId: string): string | null {
  const localBase = getLocalCubesBaseDir();

  let cubePath: string;
  if (cubeId === MEMOS_DEFAULT_CUBE) {
    const cubesDirLocal = toLocalPath(MEMOS_CUBES_DIR);
    if (cubesDirLocal.endsWith(MEMOS_DEFAULT_CUBE)) {
      cubePath = cubesDirLocal;
    } else {
      cubePath = path.join(cubesDirLocal, MEMOS_DEFAULT_CUBE);
    }
  } else {
    cubePath = path.join(localBase, cubeId);
  }

  const configPath = path.join(cubePath, "config.json");
  if (fs.existsSync(cubePath) && fs.statSync(cubePath).isDirectory() && fs.existsSync(configPath)) {
    return cubePath;
  }
  return null;
}

/**
 * Get the original (possibly Windows) path for the cube, for API registration.
 * The API runs on Windows, so it needs the Windows path.
 */
function getCubeApiPath(cubeId: string): string | null {
  const localPath = getCubePath(cubeId);
  if (!localPath) return null;

  // Convert back to Windows path if MEMOS_CUBES_DIR is a Windows path
  const cubesDir = MEMOS_CUBES_DIR;
  const isWindowsPath = /^[A-Za-z]:/.test(cubesDir);

  if (isWindowsPath) {
    // Local path is /mnt/g/... → G:\...
    const match = localPath.match(/^\/mnt\/([a-z])\/(.*)/);
    if (match) {
      const drive = match[1].toUpperCase();
      const rest = match[2].replace(/\//g, "\\");
      return `${drive}:\\${rest}`;
    }
  }

  return localPath;
}

// ============================================================================
// Cube Configuration
// ============================================================================

function cloneConfig(config: CubeConfig): CubeConfig {
  return JSON.parse(JSON.stringify(config)) as CubeConfig;
}

function updateConfigForCube(config: CubeConfig, cubeId: string): CubeConfig {
  config.user_id = MEMOS_USER;
  config.cube_id = cubeId;
  config.config_filename = "config.json";

  const textMem = config.text_mem;
  if (typeof textMem === "object" && textMem !== null) {
    const textCfg = (textMem as Record<string, unknown>).config;
    if (typeof textCfg === "object" && textCfg !== null) {
      const tc = textCfg as Record<string, unknown>;
      if ("cube_id" in tc) tc.cube_id = cubeId;

      const graphDb = tc.graph_db;
      if (typeof graphDb === "object" && graphDb !== null) {
        const graphCfg = (graphDb as Record<string, unknown>).config;
        if (typeof graphCfg === "object" && graphCfg !== null) {
          const gc = graphCfg as Record<string, unknown>;
          const useMultiDb = gc.use_multi_db;
          if (useMultiDb === false || "user_name" in gc) {
            gc.user_name = cubeId;
          }
          const vecCfg = typeof gc.vec_config === "object" && gc.vec_config !== null
            ? (gc.vec_config as Record<string, unknown>).config
            : null;
          if (vecCfg && typeof vecCfg === "object" && "collection_name" in vecCfg) {
            (vecCfg as Record<string, unknown>).collection_name = `${cubeId}_graph`;
          }
        }
      }

      const vectorDb = tc.vector_db;
      if (typeof vectorDb === "object" && vectorDb !== null) {
        const vectorCfg = (vectorDb as Record<string, unknown>).config;
        if (typeof vectorCfg === "object" && vectorCfg !== null && "collection_name" in vectorCfg) {
          (vectorCfg as Record<string, unknown>).collection_name = `${cubeId}_collection`;
        }
      }
    }
  }

  return config;
}

// Fallback cube config built from environment variables — ported from the Python
// server's _build_fallback_cube_config. Throws a descriptive error when a required
// var is missing (caller surfaces it), instead of silently producing a broken cube.
function requireEnv(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`${key} is required to build a fallback cube config (set ${key} in .env)`);
  return v;
}
function envFloat(key: string): number {
  const n = Number(requireEnv(key));
  if (Number.isNaN(n)) throw new Error(`${key} must be a number`);
  return n;
}
function envInt(key: string): number {
  const n = parseInt(requireEnv(key), 10);
  if (Number.isNaN(n)) throw new Error(`${key} must be an int`);
  return n;
}
// Optional boolean switches — fall back to a sane default when unset, so a cube
// can still be built in environments that don't define every strategy flag
// (missing BM25_CALL/VEC_COT_CALL/NEO4J_* switches must not fail registration).
function envBool(key: string, def: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (v === undefined || v === "") return def;
  return v === "true" || v === "1" || v === "yes";
}

function buildFallbackCubeConfig(cubeId: string): CubeConfig {
  const openaiConfig = {
    model_name_or_path: requireEnv("MOS_CHAT_MODEL"),
    temperature: envFloat("MOS_CHAT_TEMPERATURE"),
    max_tokens: envInt("MOS_MAX_TOKENS"),
    top_p: envFloat("MOS_TOP_P"),
    top_k: envInt("MOS_TOP_K"),
    remove_think_prefix: true,
    api_key: requireEnv("OPENAI_API_KEY"),
    api_base: requireEnv("OPENAI_API_BASE"),
  };

  const embedderConfig = {
    backend: requireEnv("MOS_EMBEDDER_BACKEND"),
    config: {
      provider: requireEnv("MOS_EMBEDDER_PROVIDER"),
      api_key: requireEnv("OPENAI_API_KEY"),
      model_name_or_path: requireEnv("MOS_EMBEDDER_MODEL"),
      base_url: process.env.MOS_EMBEDDER_API_BASE?.trim() || requireEnv("OPENAI_API_BASE"),
      embedding_dims: envInt("EMBEDDING_DIMENSION"),
    },
  };

  const neo4jBackend = requireEnv("NEO4J_BACKEND").toLowerCase();
  let graphConfig: Record<string, unknown>;
  if (neo4jBackend === "neo4j") {
    graphConfig = {
      uri: requireEnv("NEO4J_URI"),
      user: requireEnv("NEO4J_USER"),
      db_name: requireEnv("NEO4J_DB_NAME"),
      password: requireEnv("NEO4J_PASSWORD"),
      auto_create: envBool("NEO4J_AUTO_CREATE", false),
      use_multi_db: envBool("NEO4J_USE_MULTI_DB", false),
      user_name: cubeId,
      embedding_dimension: envInt("EMBEDDING_DIMENSION"),
    };
  } else {
    const qdrantUrl = process.env.QDRANT_URL?.trim() || null;
    graphConfig = {
      uri: requireEnv("NEO4J_URI"),
      user: requireEnv("NEO4J_USER"),
      db_name: requireEnv("NEO4J_DB_NAME"),
      password: requireEnv("NEO4J_PASSWORD"),
      user_name: cubeId,
      auto_create: false,
      use_multi_db: false,
      embedding_dimension: envInt("EMBEDDING_DIMENSION"),
      vec_config: {
        backend: "qdrant",
        config: {
          collection_name: `${cubeId}_graph`,
          vector_dimension: envInt("EMBEDDING_DIMENSION"),
          distance_metric: "cosine",
          host: qdrantUrl ? null : requireEnv("QDRANT_HOST"),
          port: qdrantUrl ? null : envInt("QDRANT_PORT"),
          path: process.env.QDRANT_PATH?.trim() || null,
          url: qdrantUrl,
          api_key: process.env.QDRANT_API_KEY?.trim() || null,
        },
      },
    };
  }

  return {
    model_schema: "memos.configs.mem_cube.GeneralMemCubeConfig",
    user_id: MEMOS_USER,
    cube_id: cubeId,
    config_filename: "config.json",
    text_mem: {
      backend: "tree_text",
      config: {
        extractor_llm: { backend: "openai", config: openaiConfig },
        dispatcher_llm: { backend: "openai", config: openaiConfig },
        embedder: embedderConfig,
        graph_db: { backend: neo4jBackend, config: graphConfig },
        reorganize: envBool("MOS_ENABLE_REORGANIZE", false),
        search_strategy: {
          bm25: envBool("BM25_CALL", false),
          cot: envBool("VEC_COT_CALL", false),
        },
      },
    },
    act_mem: {},
    para_mem: {},
  } as CubeConfig;
}

function buildCubeConfig(cubeId: string): CubeConfig {
  const templatePath = getCubePath(MEMOS_DEFAULT_CUBE);
  if (templatePath !== null) {
    const configPath = path.join(templatePath, "config.json");
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as CubeConfig;
      const cloned = cloneConfig(config);
      return updateConfigForCube(cloned, cubeId);
    } catch (err) {
      logger.warning(`Failed to read template cube config: ${err}`);
    }
  }
  // No usable template — build a complete config from env (throws with a clear
  // message if required vars are missing; caller reports it as a registration error).
  return buildFallbackCubeConfig(cubeId);
}

export function validateAndFixCubeConfig(cubeId: string, configPath: string): [boolean, string | null] {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as CubeConfig;
    let modified = false;

    if (config.cube_id !== cubeId) {
      config.cube_id = cubeId;
      modified = true;
    }

    const textMem = config.text_mem;
    if (typeof textMem === "object" && textMem !== null) {
      const textCfg = (textMem as Record<string, unknown>).config;
      if (typeof textCfg === "object" && textCfg !== null) {
        const tc = textCfg as Record<string, unknown>;
        if (tc.cube_id !== cubeId) {
          tc.cube_id = cubeId;
          modified = true;
        }

        const graphDb = tc.graph_db;
        if (typeof graphDb === "object" && graphDb !== null) {
          const graphCfg = (graphDb as Record<string, unknown>).config;
          if (typeof graphCfg === "object" && graphCfg !== null) {
            const gc = graphCfg as Record<string, unknown>;
            if (gc.user_name && gc.user_name !== cubeId) {
              gc.user_name = cubeId;
              modified = true;
            }
            const vecCfg = typeof gc.vec_config === "object" && gc.vec_config !== null
              ? (gc.vec_config as Record<string, unknown>).config
              : null;
            if (vecCfg && typeof vecCfg === "object" && "collection_name" in vecCfg) {
              const expected = `${cubeId}_graph`;
              if ((vecCfg as Record<string, unknown>).collection_name !== expected) {
                (vecCfg as Record<string, unknown>).collection_name = expected;
                modified = true;
              }
            }
          }
        }
      }
    }

    if (modified) {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    }

    return [modified, null];
  } catch (err) {
    return [false, `Failed to validate cube config: ${err}`];
  }
}

export function ensureCubeDirectory(cubeId: string): [string | null, string | null] {
  const localBase = getLocalCubesBaseDir();
  try {
    fs.mkdirSync(localBase, { recursive: true });
    const cubeDir = path.join(localBase, cubeId);
    const configPath = path.join(cubeDir, "config.json");

    if (fs.existsSync(cubeDir) && fs.existsSync(configPath)) {
      validateAndFixCubeConfig(cubeId, configPath);
      return [cubeDir, null];
    }

    fs.mkdirSync(cubeDir, { recursive: true });
    const config = buildCubeConfig(cubeId);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return [cubeDir, null];
  } catch (err) {
    return [null, `Failed to create cube '${cubeId}': ${err}`];
  }
}

// ============================================================================
// Cube Registration
// ============================================================================

export async function verifyCubeLoaded(cubeId: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(
      `${MEMOS_URL}/memories?user_id=${encodeURIComponent(MEMOS_USER)}&mem_cube_id=${encodeURIComponent(cubeId)}&limit=1`,
      { method: "GET", timeoutMs: 5 }
    );
    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      return data.code === 200;
    }
  } catch {
    // ignore
  }
  return false;
}

export async function ensureCubeRegistered(
  cubeId: string,
  force = false
): Promise<[boolean, string | null]> {
  const now = Date.now() / 1000;

  if (!force && registeredCubes.has(cubeId)) return [true, null];

  if (!force) {
    const lastAttempt = lastRegistrationAttempt.get(cubeId) ?? 0;
    if (now - lastAttempt < REGISTRATION_RETRY_INTERVAL && registeredCubes.has(cubeId)) {
      return [true, null];
    }
  }

  lastRegistrationAttempt.set(cubeId, now);

  try {
    // Check if already loaded
    if (await verifyCubeLoaded(cubeId)) {
      registeredCubes.add(cubeId);
      logger.debug(`Cube '${cubeId}' already loaded`);
      return [true, null];
    }

    // Get or create cube path
    let cubePath = getCubeApiPath(cubeId);
    if (!cubePath) {
      // Try to auto-create (ensureCubeDirectory handles both template-clone and fallback)
      logger.debug(`Cube '${cubeId}' not found, attempting auto-creation...`);

      const [newDir, createErr] = ensureCubeDirectory(cubeId);
      if (!newDir) {
        return [false, `Failed to auto-create cube '${cubeId}': ${createErr}`];
      }

      cubePath = getCubeApiPath(cubeId);
      if (!cubePath) {
        return [false, `Failed to get path for cube '${cubeId}' after creation`];
      }
    }

    // Register with API
    const response = await fetchWithTimeout(`${MEMOS_URL}/mem_cubes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: MEMOS_USER,
        mem_cube_name_or_path: cubePath,
        mem_cube_id: cubeId,
      }),
      timeoutMs: MEMOS_TIMEOUT_STARTUP,
    });

    if (response.ok) {
      const data = await response.json() as Record<string, unknown>;
      if (data.code === 200) {
        registeredCubes.add(cubeId);
        logger.debug(`Auto-registered cube: ${cubeId}`);
        return [true, null];
      }
      const msg = String(data.message ?? "Unknown error");
      if (msg.toLowerCase().includes("already")) {
        registeredCubes.add(cubeId);
        return [true, null];
      }
      const available = listAvailableCubes();
      const availableIds = available.map((c) => c.id);
      return [false, `Failed to register cube '${cubeId}': ${msg}. Available: ${availableIds.join(", ") || "none"}`];
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed") || msg.includes("ECONNRESET")) {
      return [false, `Cannot connect to MemOS API at ${MEMOS_URL}. Is the server running?`];
    }
    return [false, `Failed to register cube '${cubeId}': ${err}`];
  }

  return [false, `Unknown error registering cube '${cubeId}'`];
}

// ============================================================================
// Default Cube ID
// ============================================================================

export function getDefaultCubeId(): string {
  if (isDefaultCubeFromEnv()) {
    if (getCubePath(MEMOS_DEFAULT_CUBE) !== null) {
      return MEMOS_DEFAULT_CUBE;
    }
  }
  try {
    return detectCubeFromPath(process.cwd());
  } catch {
    return MEMOS_DEFAULT_CUBE;
  }
}
