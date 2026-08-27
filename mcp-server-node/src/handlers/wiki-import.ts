/**
 * memos_import_wiki — import an exported wiki back into its cube
 *
 * Round-trip counterpart of wiki-export.ts: pages keep the memory id in
 * front-matter, so import compares page-by-page against the cube:
 *   missing id   -> POST /memories (typed fast path stores verbatim, no LLM)
 *   unchanged    -> skipped (durable id-based dedup)
 *   edited       -> skipped by default; on_edit="version" saves a new version
 *                   (the tree_text backend cannot update in place — core.py
 *                   update() is a no-op there — so the old memory is kept)
 *
 * Versioned pages are recorded in .wiki-import-ledger.json with the content
 * hash, imported timestamp, and IDs returned by the API. The API now restores
 * type/tags/confidence/status/timestamps; relation wikilinks remain reporting
 * only until a relation-aware write endpoint exists.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { MEMOS_URL, MEMOS_USER, logger } from "../config.js";
import { apiCallWithRetry } from "../api-client.js";
import { ensureCubeRegistered } from "../cube-manager.js";
import { parseMemoryWriteResponse } from "../memory-write-response.js";
import {
  inspectWikiPages,
  normalizeLedger,
  type LedgerEntry,
} from "../wiki-import-safety.js";
import {
  buildFileBaseIndex,
  relationEdges,
  type RelationEdge,
} from "../wiki-relations.js";
import { writeRelationsForPage } from "./wiki-import-relations.js";
import {
  buildMemoryContent,
  parseWikiPage,
  stripTypePrefix,
  type ParsedWikiPage,
} from "../wiki-import-format.js";
import type { TextContent, MemoryNode } from "../types.js";
import {
  ERR_OPERATION_FAILED,
  ERR_PARAM_MISSING,
  apiErrorResponse,
  cubeRegistrationError,
  errorResponse,
  getCubeIdFromArgs,
} from "./utils.js";

const LEDGER_FILE = ".wiki-import-ledger.json";
const LOCK_FILE = ".wiki-import.lock";
const LOCK_STALE_MS = 15 * 60 * 1000;
const MAX_IMPORT_PAGES = 1000; // mirrors the export cap (10 pages x 100)
const REPORT_LIST_LIMIT = 5;

interface PageOutcome {
  page: ParsedWikiPage;
  relPath: string;
}

interface ImportLedgerEntry {
  content_hash: string;
  new_memory_ids: string[];
  imported_at: string;
}

type ImportLedger = Record<string, ImportLedgerEntry | string>;

interface SavePageResult {
  error: string | null;
  memoryIds: string[];
  warnings: string[];
  uncertain: boolean;
}

// ============================================================================
// File system helpers
// ============================================================================

function collectMarkdownFiles(pagesDir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(pagesDir)) return files;

  const walk = (dir: string): void => {
    if (files.length >= MAX_IMPORT_PAGES) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_IMPORT_PAGES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(pagesDir);
  return files;
}

function contentHash(page: ParsedWikiPage): string {
  return crypto
    .createHash("sha256")
    .update(`${page.type}\n${page.content}`)
    .digest("hex");
}

function loadLedger(wikiDir: string): ImportLedger | string {
  const ledgerPath = path.join(wikiDir, LEDGER_FILE);
  if (!fs.existsSync(ledgerPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as unknown;
    const normalized = normalizeLedger(parsed);
    return normalized.ok ? normalized.ledger : normalized.reason;
  } catch (err) {
    return `cannot parse ${LEDGER_FILE}: ${String(err)}`;
  }
}

function saveLedger(wikiDir: string, ledger: ImportLedger): boolean {
  const target = path.join(wikiDir, LEDGER_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(temp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(ledger, null, 2), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best effort */
    }
    return false;
  }
}

function acquireImportLock(wikiDir: string): string | null {
  const lockPath = path.join(wikiDir, LOCK_FILE);
  try {
    const now = Date.now();
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      if (now - stat.mtimeMs < LOCK_STALE_MS)
        return `Wiki import already running: ${lockPath}`;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return `stale lock cannot be removed: ${lockPath}`;
      }
    }
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        started_at: new Date(now).toISOString(),
      }),
    );
    fs.closeSync(fd);
    return null;
  } catch {
    return `cannot acquire wiki import lock: ${lockPath}`;
  }
}

function releaseImportLock(wikiDir: string): void {
  try {
    fs.unlinkSync(path.join(wikiDir, LOCK_FILE));
  } catch {
    /* another process may own it */
  }
}

/** Returns the stored node, null when the memory does not exist, or an error string. */
async function getStoredMemory(
  cubeId: string,
  memoryId: string,
): Promise<MemoryNode | null | string> {
  const result = await apiCallWithRetry(
    "GET",
    `${MEMOS_URL}/memories/${cubeId}/${memoryId}`,
    cubeId,
    // 同 handlers/memory.ts 的 handleMemosGet：缺 user_id 会让后端回退到 root，
    // 对 MEMOS_USER 名下的 cube 报「does not have access」。这里更隐蔽 —— 该错误
    // 既不含 "not found" 也不是 404，会被当成真实故障返回，把整页 import 判成失败。
    { params: { user_id: MEMOS_USER } },
    ensureCubeRegistered,
  );
  if (result.success) {
    return (
      ((result.data as Record<string, unknown> | null)
        ?.data as MemoryNode | null) ?? null
    );
  }
  const msg = String(
    (result.data as Record<string, unknown> | null)?.message ?? "",
  );
  if (msg.toLowerCase().includes("not found") || result.status === 404)
    return null;
  return msg || `HTTP ${result.status}`;
}

async function savePageAsMemory(
  cubeId: string,
  page: ParsedWikiPage,
): Promise<SavePageResult> {
  const body: Record<string, unknown> = {
    user_id: MEMOS_USER,
    mem_cube_id: cubeId,
    memory_content: buildMemoryContent(page),
    memory_type: page.type,
    tags: page.tags,
    status: page.status,
  };
  if (page.confidence !== undefined) body.confidence = page.confidence;
  if (page.created) body.created_at = page.created;
  if (page.updated) body.updated_at = page.updated;
  const result = await apiCallWithRetry(
    "POST",
    `${MEMOS_URL}/memories`,
    cubeId,
    { body },
    ensureCubeRegistered,
  );
  if (!result.success) {
    return {
      error: String(
        (result.data as Record<string, unknown> | null)?.message ??
          `HTTP ${result.status}`,
      ),
      memoryIds: [],
      warnings: [],
      uncertain: false,
    };
  }
  const parsed = parseMemoryWriteResponse(
    result.data as { code: number; data?: unknown },
  );
  return {
    error: null,
    memoryIds: parsed.memoryIds,
    warnings: parsed.warnings,
    uncertain: parsed.memoryIds.length === 0,
  };
}

// ============================================================================
// Handler
// ============================================================================

export async function handleMemosImportWiki(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const projectPath = arguments_.project_path as string | undefined;
  const dryRun = arguments_.dry_run === true;
  const onEdit = arguments_.on_edit === "version" ? "version" : "skip";

  const wikiDir =
    (arguments_.wiki_dir as string | undefined) ??
    (projectPath ? path.join(projectPath, "docs", "memory-wiki") : undefined);
  if (!wikiDir) {
    return errorResponse(
      "Need project_path (default wiki: <project_path>/docs/memory-wiki) or an explicit wiki_dir",
      ERR_PARAM_MISSING,
      [
        '`memos_import_wiki(project_path="/mnt/g/my/project")`',
        "Run `memos_export_wiki` first, edit pages, then import",
      ],
    );
  }
  const resolvedDir = path.resolve(wikiDir);
  const pagesDir = path.join(resolvedDir, "pages");
  const lockError = acquireImportLock(resolvedDir);
  if (lockError) return errorResponse(lockError, ERR_OPERATION_FAILED);
  try {
    if (!fs.existsSync(pagesDir)) {
      return errorResponse(
        `No pages directory under '${resolvedDir}' — export a wiki first`,
        ERR_OPERATION_FAILED,
        [
          `memos_export_wiki(project_path="...") writes <project_path>/docs/memory-wiki/pages/`,
        ],
      );
    }

    const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
    if (!regSuccess) return cubeRegistrationError(cubeId, regError);

    const files = collectMarkdownFiles(pagesDir);
    const parsed: PageOutcome[] = [];
    const failures: string[] = [];
    let foreign = 0;

    for (const file of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (err) {
        failures.push(
          `${path.relative(resolvedDir, file)}: unreadable (${err})`,
        );
        continue;
      }
      const result = parseWikiPage(raw);
      if (result.ok)
        parsed.push({
          page: result.page,
          relPath: path.relative(resolvedDir, file),
        });
      else if (result.foreign) foreign += 1;
      else
        failures.push(`${path.relative(resolvedDir, file)}: ${result.reason}`);
    }

    if (parsed.length === 0) {
      return errorResponse(
        `No importable pages under '${pagesDir}' — ${files.length} .md scanned, ${foreign} not generated by oh-memos, ${failures.length} malformed`,
        ERR_OPERATION_FAILED,
        [
          "Only pages generated by `memos_export_wiki` (front-matter marker) can be imported — other files are left untouched",
          ...failures.slice(0, REPORT_LIST_LIMIT).map((f) => `Malformed: ${f}`),
        ],
      );
    }

    const identityCheck = inspectWikiPages(
      parsed.map(({ page, relPath }) => ({ id: page.id, relPath })),
    );
    if (!identityCheck.ok) {
      return errorResponse(
        `Duplicate memory IDs in wiki pages; no writes performed: ${identityCheck.duplicates.map((d) => `${d.id} (${d.paths.join(", ")})`).join("; ")}`,
        ERR_OPERATION_FAILED,
      );
    }

    // Build a wikilink → id index once; relation writes need this after each page is saved.
    const fileBaseIndex = buildFileBaseIndex(
      parsed.map(({ page, relPath }) => ({ id: page.id, relPath })),
    );

    const loadedLedger = loadLedger(resolvedDir);
    if (typeof loadedLedger === "string") {
      return errorResponse(
        `Cannot import: ${loadedLedger}. Restore or remove the ledger only after reviewing it.`,
        ERR_OPERATION_FAILED,
      );
    }
    const ledger: ImportLedger = loadedLedger;
    let ledgerDirty = false;
    let created = 0;
    let unchanged = 0;
    let versioned = 0;
    let alreadyVersioned = 0;
    let editSkipped = 0;
    let archived = 0;
    let idWarnings = 0;
    let relationsWritten = 0;
    let relationsUnresolved = 0;
    let relationsFailed = 0;
    const apiWarnings: string[] = [];
    const versionedList: string[] = [];
    const editSkippedList: string[] = [];

    for (const { page } of parsed) {
      const ledgerEntry = ledger[page.id];
      if (page.status !== "activated") {
        archived += 1;
        continue;
      }

      if (
        ledgerEntry &&
        typeof ledgerEntry !== "string" &&
        ledgerEntry.new_memory_ids.length > 0
      ) {
        // The old page has already produced a new version; compare the edited
        // content hash before doing another API lookup/version.
        const mappedHash = ledgerEntry.content_hash;
        if (mappedHash === contentHash(page)) {
          alreadyVersioned += 1;
          continue;
        }
      }

      const stored = await getStoredMemory(cubeId, page.id);
      if (typeof stored === "string") {
        failures.push(`${page.title}: lookup failed (${stored})`);
        continue;
      }

      if (stored === null) {
        if (!dryRun) {
          const saved = await savePageAsMemory(cubeId, page);
          if (saved.error) {
            failures.push(`${page.title}: save failed (${saved.error})`);
            continue;
          }
          if (saved.warnings.length > 0)
            apiWarnings.push(`${page.title}: ${saved.warnings.join("; ")}`);
          if (saved.uncertain) {
            idWarnings += 1;
            failures.push(
              `${page.title}: write acknowledged without memory_ids; ledger not committed`,
            );
            continue;
          }
          ledger[page.id] = {
            content_hash: contentHash(page),
            new_memory_ids: saved.memoryIds,
            imported_at: new Date().toISOString(),
          };
          ledgerDirty = true;

          // Write relations after the new memory exists; use the first returned id.
          if (saved.memoryIds.length > 0 && page.related.length > 0) {
            const relResult = await writeRelationsForPage(
              cubeId,
              saved.memoryIds[0],
              page,
              fileBaseIndex,
            );
            relationsWritten += relResult.written;
            relationsUnresolved += relResult.unresolved.length;
            relationsFailed += relResult.failed.length;
            if (relResult.unresolved.length > 0)
              apiWarnings.push(
                `${page.title}: ${relResult.unresolved.length} unresolved wikilinks`,
              );
            if (relResult.failed.length > 0)
              apiWarnings.push(
                `${page.title}: ${relResult.failed.length} relation writes failed`,
              );
          }
        }
        created += 1;
        continue;
      }

      const storedContent = stripTypePrefix(String(stored.memory ?? "")).trim();
      if (storedContent === page.content.trim()) {
        unchanged += 1;
        continue;
      }

      const ledgerHash =
        typeof ledgerEntry === "string"
          ? ledgerEntry
          : ledgerEntry?.content_hash;
      if (ledgerHash === contentHash(page)) {
        alreadyVersioned += 1;
        continue;
      }
      if (onEdit === "skip") {
        editSkipped += 1;
        editSkippedList.push(`${page.title} (${page.id})`);
        continue;
      }

      if (!dryRun) {
        const saved = await savePageAsMemory(cubeId, page);
        if (saved.error) {
          failures.push(
            `${page.title}: versioned save failed (${saved.error})`,
          );
          continue;
        }
        if (saved.warnings.length > 0)
          apiWarnings.push(`${page.title}: ${saved.warnings.join("; ")}`);
        if (saved.uncertain) {
          idWarnings += 1;
          failures.push(
            `${page.title}: version write acknowledged without memory_ids; ledger not committed`,
          );
          continue;
        }
        ledger[page.id] = {
          content_hash: contentHash(page),
          new_memory_ids: saved.memoryIds,
          imported_at: new Date().toISOString(),
        };
        ledgerDirty = true;

        // Write relations for the versioned page's new id.
        if (saved.memoryIds.length > 0 && page.related.length > 0) {
          const relResult = await writeRelationsForPage(
            cubeId,
            saved.memoryIds[0],
            page,
            fileBaseIndex,
          );
          relationsWritten += relResult.written;
          relationsUnresolved += relResult.unresolved.length;
          relationsFailed += relResult.failed.length;
          if (relResult.unresolved.length > 0)
            apiWarnings.push(
              `${page.title}: ${relResult.unresolved.length} unresolved wikilinks`,
            );
          if (relResult.failed.length > 0)
            apiWarnings.push(
              `${page.title}: ${relResult.failed.length} relation writes failed`,
            );
        }
      }
      versioned += 1;
      versionedList.push(`${page.title} (old id ${page.id})`);
    }

    if (!dryRun && ledgerDirty && !saveLedger(resolvedDir, ledger)) {
      failures.push(
        `ledger write failed (${LEDGER_FILE}); re-import may version edited pages again`,
      );
    }
    logger.info(
      `Wiki import: ${created} created, ${versioned} versioned, ${unchanged} unchanged, ${failures.length} failed -> ${resolvedDir}`,
    );

    const lines = [
      `## 📥 Wiki 导入${dryRun ? "（dry-run 预览，未写入）" : "完成"}`,
      "",
      `**目录**: \`${resolvedDir}\` · **cube**: ${cubeId}`,
      `**新增**: ${created} · **未改动跳过**: ${unchanged} · **版本化**: ${versioned} · **此前已版本化**: ${alreadyVersioned} · **编辑跳过**: ${editSkipped} · **归档跳过**: ${archived} · **关系写入**: ${relationsWritten} · **关系未解析**: ${relationsUnresolved} · **关系失败**: ${relationsFailed} · **无 ID 兼容响应**: ${idWarnings} · **失败**: ${failures.length}${foreign > 0 ? ` · **非生成文件忽略**: ${foreign}` : ""}`,
    ];

    if (editSkippedList.length > 0) {
      lines.push(
        "",
        `ℹ️ ${editSkippedList.length} 个已编辑页按默认策略跳过，重跑以保存为新版本：`,
        ...editSkippedList.slice(0, REPORT_LIST_LIMIT).map((s) => `- ${s}`),
      );
    }
    if (versionedList.length > 0) {
      lines.push(
        "",
        `⚠️ 已编辑页保存为新版本，旧记忆保留（tree_text 后端暂不支持原地更新）：`,
        ...versionedList.slice(0, REPORT_LIST_LIMIT).map((s) => `- ${s}`),
      );
    }
    if (failures.length > 0) {
      lines.push(
        "",
        `❌ 失败明细（前 ${REPORT_LIST_LIMIT} 条）：`,
        ...failures.slice(0, REPORT_LIST_LIMIT).map((s) => `- ${s}`),
      );
    }
    if (apiWarnings.length > 0) {
      lines.push(
        "",
        "⚠️ API warnings:",
        ...apiWarnings
          .slice(0, REPORT_LIST_LIMIT)
          .map((warning) => `- ${warning}`),
      );
    }
    lines.push(
      "",
      "ℹ️ 导入恢复 type/tags/confidence/status/时间字段；关联 wikilinks 写入 Neo4j 关系边；写入内容经过服务端凭据脱敏。",
    );
    return [{ type: "text", text: lines.join("\n") }];
  } finally {
    releaseImportLock(resolvedDir);
  }
}
