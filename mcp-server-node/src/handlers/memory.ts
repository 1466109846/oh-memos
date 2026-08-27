/**
 * Memory Handlers
 *
 * memos_save, memos_list_v2, memos_get, memos_admin(action="stats")
 */

import * as crypto from "crypto";
import { MEMOS_URL, MEMOS_USER, MEMOS_CUBES_DIR, logger } from "../config.js";
import { getMemoryProvider } from "../providers/provider-factory.js";
import { apiCallWithRetry } from "../api-client.js";
import { ensureCubeRegistered } from "../cube-manager.js";
import { parseMemoryWriteResponse } from "../memory-write-response.js";
import { recordAccess } from "../access-tracker.js";
import { filterEphemeralTier } from "../memory-tier.js";
import {
  findSiblings,
  renderVerbatimSections,
  verbatimOf,
  type SiblingRef,
} from "../verbatim-source.js";
// formatMemoriesForDisplay intentionally not imported here — list output is built
// from the truncated allMemories in handleMemosList (avoids printing the full cube).
import {
  COMPACTION_THRESHOLD,
  PREVIEW_COUNT,
  shouldCompact,
  compactedResultToText,
  toMinimal,
  toFull,
} from "../models.js";
import { computeMemoryStats, extractMcpType } from "../query-processing.js";
import type { TextContent, MemoryNode, SearchData } from "../types.js";
import {
  ERR_PARAM_MISSING,
  apiErrorResponse,
  cubeRegistrationError,
  errorResponse,
  getCubeIdFromArgs,
} from "./utils.js";

// ============================================================================
// Deduplication Cache
// ============================================================================

const saveDedupCache: Map<string, [string, number]> = new Map();
const DEDUP_TTL_SECONDS = 60;

function contentHash(content: string, cubeId: string): string {
  return crypto.createHash("md5").update(`${cubeId}:${content}`).digest("hex");
}

function isDuplicateSave(content: string, cubeId: string): boolean {
  const key = contentHash(content, cubeId);
  const now = Date.now() / 1000;

  // Clean expired
  for (const [k, [, ts]] of saveDedupCache) {
    if (now - ts > DEDUP_TTL_SECONDS) saveDedupCache.delete(k);
  }

  const entry = saveDedupCache.get(key);
  if (entry && now - entry[1] < DEDUP_TTL_SECONDS) {
    logger.debug(
      `Duplicate save detected (within ${DEDUP_TTL_SECONDS}s), skipping`,
    );
    return true;
  }
  return false;
}

function markSaved(content: string, cubeId: string): void {
  const key = contentHash(content, cubeId);
  saveDedupCache.set(key, [cubeId, Date.now() / 1000]);
}

// ============================================================================
// memos_save
// ============================================================================

export async function handleMemosSave(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  let content = String(arguments_.content ?? "");
  const memoryType = arguments_.memory_type as string | undefined;

  if (!memoryType) {
    return errorResponse(
      "memory_type parameter is required",
      ERR_PARAM_MISSING,
      [
        "Bug fix -> `BUGFIX` or `ERROR_PATTERN`",
        "Technical decision -> `DECISION`",
        "Gotcha/trap -> `GOTCHA`",
        "Code template -> `CODE_PATTERN`",
        "Config change -> `CONFIG`",
        "New feature -> `FEATURE`",
        "Major achievement -> `MILESTONE`",
        "Pure progress update -> `PROGRESS`",
        "Synthesized answer from memos_think evidence -> `SYNTHESIS`",
        'Example: `memos_save(content="...", memory_type="BUGFIX")`',
      ],
    );
  }

  if (!content.startsWith(`[${memoryType}]`)) {
    content = `[${memoryType}] ${content}`;
  }

  if (isDuplicateSave(content, cubeId)) {
    return [
      {
        type: "text",
        text: `⏭️ Skipped: Same content was saved within ${DEDUP_TTL_SECONDS}s (dedup protection)`,
      },
    ];
  }

  const provider = getMemoryProvider(MEMOS_CUBES_DIR);
  if (provider) {
    const saved = await provider.save({
      cubeId,
      content,
      memoryType,
      tags: [memoryType],
    });
    markSaved(content, cubeId);
    return [
      {
        type: "text",
        text: `Memory saved as [${memoryType}] in local cube '${cubeId}' · ID: ${saved.id}`,
      },
    ];
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  const result = await apiCallWithRetry(
    "POST",
    `${MEMOS_URL}/memories`,
    cubeId,
    {
      body: {
        user_id: MEMOS_USER,
        mem_cube_id: cubeId,
        memory_content: content,
      },
    },
    ensureCubeRegistered,
  );

  if (result.success) {
    markSaved(content, cubeId);
    const write = parseMemoryWriteResponse(
      result.data as { code: number; data?: unknown },
    );
    const idText =
      write.memoryIds.length > 0 ? ` · IDs: ${write.memoryIds.join(", ")}` : "";
    const warningText =
      write.warnings.length > 0
        ? ` · warnings: ${write.warnings.join("; ")}`
        : "";
    return [
      {
        type: "text",
        text: `Memory saved as [${memoryType}] in cube '${cubeId}'${idText}${warningText}`,
      },
    ];
  } else if (result.data) {
    return apiErrorResponse(
      "Save",
      String(
        (result.data as Record<string, unknown>).message ?? "Unknown error",
      ),
    );
  } else {
    return apiErrorResponse("Save", `HTTP ${result.status}`);
  }
}

// ============================================================================
// memos_list_v2
// ============================================================================

export async function handleMemosList(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const limit = Number(arguments_.limit ?? 20);
  const memoryType = arguments_.memory_type as string | undefined;
  const compact = arguments_.compact !== false; // Default true

  const provider = getMemoryProvider(MEMOS_CUBES_DIR);
  if (provider) {
    let allMemories = await provider.list(
      cubeId,
      Math.max(limit * 20, 200),
      memoryType,
    );
    allMemories = allMemories.slice(0, limit);
    const totalCount = allMemories.length;
    if (compact && shouldCompact(totalCount)) {
      return [
        {
          type: "text",
          text: compactedResultToText({
            preview: allMemories.slice(0, PREVIEW_COUNT).map(toMinimal),
            totalCount,
            omittedCount: totalCount - Math.min(PREVIEW_COUNT, totalCount),
            message: 'Use memos_get(memory_id="<id>") for full details',
            query: "local list",
            cubeId,
          }),
        },
      ];
    }
    if (!allMemories.length)
      return [
        { type: "text", text: `## Cube: ${cubeId}\n\nNo memories found.` },
      ];
    return [
      {
        type: "text",
        text: [
          `## Cube: ${cubeId} (${allMemories.length})`,
          "",
          ...allMemories.map(
            (m, i) =>
              `${i + 1}. [${extractMcpType(m)}] ${m.memory}\n   ID: \`${m.id}\``,
          ),
        ].join("\n\n"),
      },
    ];
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  const params: Record<string, string | number | boolean> = {
    user_id: MEMOS_USER,
    mem_cube_id: cubeId,
  };
  // Always cap the pull. When filtering by memory_type we need a larger sample
  // (the API filters by internal type, not MCP type), but never the whole cube —
  // pulling everything blew a limit=5 request up to ~1.8M tokens on large cubes.
  params.limit = memoryType ? Math.max(limit * 20, 200) : limit;

  const result = await apiCallWithRetry(
    "GET",
    `${MEMOS_URL}/memories`,
    cubeId,
    { params },
    ensureCubeRegistered,
  );

  if (result.success && result.data) {
    const resultData =
      ((result.data as Record<string, unknown>).data as SearchData) ?? {};
    const allMemories = prepareListMemories(resultData, memoryType, limit);

    const totalCount = allMemories.length;

    if (compact && shouldCompact(totalCount)) {
      const preview = allMemories.slice(0, PREVIEW_COUNT).map(toMinimal);
      const text = compactedResultToText({
        preview,
        totalCount,
        omittedCount: totalCount - preview.length,
        message: 'Use memos_get(memory_id="<id>") for full details',
        query: memoryType ? `list (type=${memoryType})` : "list all",
        cubeId,
      });
      return [{ type: "text", text }];
    }

    // Non-compact path: render ONLY the filtered+truncated allMemories.
    // (Previously this fell back to formatMemoriesForDisplay(resultData) = the full
    // untrimmed pull, which is how a limit=5 request printed the entire cube.)
    if (totalCount === 0) {
      return [
        {
          type: "text",
          text: `## Cube: ${cubeId}\n\nNo memories${memoryType ? ` of type ${memoryType}` : ""} found.`,
        },
      ];
    }
    const header = memoryType
      ? `## Cube: ${cubeId} — type=${memoryType} (${totalCount})`
      : `## Cube: ${cubeId} (${totalCount})`;
    const lines = allMemories.map((m, i) => {
      const mm = toMinimal(m);
      return `${i + 1}. [${mm.memoryType}] ${mm.summary}\n   ID: \`${mm.id}\``;
    });
    return [{ type: "text", text: [header, "", ...lines].join("\n\n") }];
  } else if (result.data) {
    return apiErrorResponse(
      "List",
      String(
        (result.data as Record<string, unknown>).message ?? "Unknown error",
      ),
    );
  } else {
    return apiErrorResponse("List", `HTTP ${result.status}`);
  }
}

// ============================================================================
// memos_get
// ============================================================================

/**
 * 取同源碎片。只在当前记忆确实带原文时才发这次请求 —— fast-path 写入不会付这个代价。
 *
 * 失败即返回空数组：同源列表是附加信息，取不到时 `memos_get` 仍应给出原文。
 * 拉取量上限 200，避免大 cube 上把整库拉回来（碎片来自同一次写入，时间相邻，
 * 后端按 updated_at 倒序返回，200 条足以覆盖）。
 */
async function fetchSiblings(
  cubeId: string,
  target: MemoryNode,
): Promise<SiblingRef[]> {
  try {
    const result = await apiCallWithRetry(
      "GET",
      `${MEMOS_URL}/memories`,
      cubeId,
      { params: { user_id: MEMOS_USER, mem_cube_id: cubeId, limit: 200 } },
      ensureCubeRegistered,
    );
    if (!result.success || !result.data) return [];
    const data = (result.data as Record<string, unknown>).data as SearchData;
    return findSiblings(target, extractMemoriesFromData(data ?? {}));
  } catch (err) {
    logger.debug(`sibling lookup failed: ${String(err)}`);
    return [];
  }
}

export async function handleMemosGet(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const memoryId = String(arguments_.memory_id ?? "");

  if (!memoryId) {
    return errorResponse("memory_id parameter is required", ERR_PARAM_MISSING, [
      "Get memory_id from memos_search or memos_list_v2 results",
      'Example: `memos_get(memory_id="abc123-...")`',
    ]);
  }

  const localProvider = getMemoryProvider(MEMOS_CUBES_DIR);
  if (localProvider) {
    const node = await localProvider.get(cubeId, memoryId);
    if (!node) return [{ type: "text", text: notFoundText(memoryId) }];
    // 只在确实取到记忆后记账 —— 未命中的 id 不构成使用度信号。
    recordAccess(MEMOS_CUBES_DIR, cubeId, [memoryId]);
    const full = toFull(node, cubeId, MEMOS_USER);
    return [
      {
        type: "text",
        text: [
          "## 📝 Memory Details",
          "",
          `**ID**: \`${full.id}\``,
          `**Type**: ${full.memoryType}`,
          `**Cube**: ${full.cubeId} (local)`,
          full.tags.length ? `**Tags**: ${full.tags.join(", ")}` : "",
          full.createdAt ? `**Created**: ${full.createdAt}` : "",
          // Lite 的 JSONL 不写 sources，verbatimOf 返回 null → 保持原有输出。
          // 保留这个分支是为了后端哪天开始写该字段时自动生效。
          ...(verbatimOf(node) === null
            ? ["", "### Content", "", full.content]
            : renderVerbatimSections(verbatimOf(node), [], full.content)),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);
  const result = await apiCallWithRetry(
    "GET",
    `${MEMOS_URL}/memories/${cubeId}/${memoryId}`,
    cubeId,
    // user_id 必须显式传：后端 `get_memory` 的 user_id 是可选参数，缺失时回退到
    // MOS 实例自己的 user_id（root）。而 ensureCubeRegistered 注册的是 MEMOS_USER
    // （dev_user），于是 root 对该 cube 无授权，校验抛 ValueError → 400
    // "User 'root' does not have access to cube '...'"。重注册重试也救不回来：
    // 它仍然按 MEMOS_USER 注册，重试请求仍然不带 user_id，第二次照样落到 root。
    { params: { user_id: MEMOS_USER } },
    ensureCubeRegistered,
  );

  if (result.success && result.data) {
    const resultData = (result.data as Record<string, unknown>)
      .data as MemoryNode | null;

    if (resultData) {
      // Full 模式同样记在本机侧车 —— 使用度是本机数据，不需要后端端点。
      recordAccess(MEMOS_CUBES_DIR, cubeId, [memoryId]);
      const fullMem = toFull(resultData, cubeId, MEMOS_USER);
      const verbatim = verbatimOf(resultData);
      const lines = [
        "## 📝 Memory Details",
        "",
        `**ID**: \`${fullMem.id}\``,
        `**Type**: ${fullMem.memoryType}`,
        `**Cube**: ${fullMem.cubeId}`,
      ];

      if (fullMem.key) lines.push(`**Key**: ${fullMem.key}`);
      if (fullMem.tags.length > 0)
        lines.push(`**Tags**: ${fullMem.tags.join(", ")}`);
      if (fullMem.createdAt) lines.push(`**Created**: ${fullMem.createdAt}`);

      // 有原文时原文即正文，`memory` 字段（LLM 概括）降级到下方的「抽取概括」区块。
      // 无原文（fast-path 写入）时保持原有行为。
      if (verbatim === null) {
        lines.push("", "### Content", "", fullMem.content);
      } else {
        lines.push(
          ...renderVerbatimSections(
            verbatim,
            await fetchSiblings(cubeId, resultData),
            fullMem.content,
          ),
        );
      }

      if (fullMem.background) {
        lines.push("", "### Background", "", fullMem.background);
      }

      if (fullMem.relations && fullMem.relations.length > 0) {
        lines.push("", "### Relations", "");
        for (const rel of fullMem.relations.slice(0, 5)) {
          lines.push(`- ${JSON.stringify(rel)}`);
        }
      }

      return [{ type: "text", text: lines.join("\n") }];
    } else {
      return [{ type: "text", text: notFoundText(memoryId) }];
    }
  } else if (result.data) {
    const errMsg = String(
      (result.data as Record<string, unknown>).message ?? "Unknown error",
    );
    if (errMsg.toLowerCase().includes("not found") || result.status === 404) {
      return [{ type: "text", text: notFoundText(memoryId) }];
    }
    return apiErrorResponse("Get", errMsg);
  } else {
    return apiErrorResponse("Get", `HTTP ${result.status}`);
  }
}

/**
 * not-found 文案。
 *
 * 旧文案说「核对 id 是否正确（从 memos_search 结果复制）」，但实测中最常见的
 * 成因恰恰是**从搜索结果复制的 id 过了一会儿就失效**：`POST /search` 返回的
 * 是 `WorkingMemory` 层的副本 id，而该层按 `user_name` 只保留 20 条
 * （`manager.py` 的 `memory_size["WorkingMemory"]`），每次检索都重写并淘汰最旧的。
 * 实测 `oh_memos_cube` 的 20 条只覆盖 22 分钟。
 *
 * 所以把 `memos_list_v2` 指出来是有实质区别的：它返回 `LongTermMemory` 的 id，
 * 那一层不淘汰（实测同一批 id 隔天仍可取回）。
 *
 * 措辞上不把淘汰断言成事实 —— Lite 模式（本地 JSONL）根本没有 WorkingMemory
 * 层，那里的 not-found 就是单纯的 id 不存在。
 */
export function notFoundText(memoryId: string): string {
  return [
    `❌ Memory not found: \`${memoryId}\``,
    "",
    "💡 **可能原因**:",
    "- **id 已失效**（最常见）：`memos_search` 返回的是短期层（WorkingMemory）id，",
    "  该层每用户仅保留最近 20 条，新检索会淘汰旧的。取回长期 id 请用 `memos_list_v2`。",
    "- 记忆确实已被删除",
    "- cube 不对：确认传了正确的 `project_path`",
    "",
    "✅ **下一步**: 用 `memos_search` 重新检索拿到当前有效 id，",
    "或用 `memos_list_v2` 拿持久 id。",
  ].join("\n");
}

// ============================================================================
// memos_admin(action="stats")
// ============================================================================

export async function handleMemosGetStats(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  const result = await apiCallWithRetry(
    "GET",
    `${MEMOS_URL}/memories`,
    cubeId,
    { params: { user_id: MEMOS_USER, mem_cube_id: cubeId } },
    ensureCubeRegistered,
  );

  if (result.success && result.data) {
    const [stats, total] = computeMemoryStats(
      ((result.data as Record<string, unknown>).data as SearchData) ?? {},
    );

    if (total === 0) {
      return [{ type: "text", text: `No memories found in cube '${cubeId}'.` }];
    }

    const typeIcons: Record<string, string> = {
      BUGFIX: "🐛",
      ERROR_PATTERN: "🔴",
      DECISION: "📋",
      GOTCHA: "⚠️",
      CODE_PATTERN: "📝",
      CONFIG: "⚙️",
      FEATURE: "✨",
      MILESTONE: "🎯",
      PROGRESS: "📊",
      INFERRED: "🔗",
      SYNTHESIS: "🧠",
    };

    const result_lines = [
      `## 📊 Memory Stats: ${cubeId}`,
      `Total Memories: **${total}**`,
      "",
    ];

    for (const [mtype, count] of Object.entries(stats).sort(
      (a, b) => b[1] - a[1],
    )) {
      const percentage = ((count / total) * 100).toFixed(1);
      const icon = typeIcons[mtype] ?? "📌";
      result_lines.push(`- ${icon} **${mtype}**: ${count} (${percentage}%)`);
    }

    const inferredCount = stats.INFERRED ?? 0;
    const progressCount = stats.PROGRESS ?? 0;
    const userTyped = total - inferredCount - progressCount;

    if (inferredCount > 0) {
      result_lines.push(
        "",
        "---",
        "",
        `ℹ️ **INFERRED** (${inferredCount} 条): 图数据库自动生成的因果推断节点，非用户保存，属正常现象。`,
      );
    }

    if (total > 0 && progressCount / total > 0.5) {
      result_lines.push(
        "",
        "---",
        "",
        `⚠️ **PROGRESS 占比偏高** (${progressCount}/${total}): 保存时建议显式指定类型:`,
      );
      result_lines.push(
        "   `BUGFIX` · `DECISION` · `MILESTONE` · `FEATURE` · `GOTCHA` · `CONFIG`",
      );
    }

    if (userTyped > 0) {
      result_lines.push(
        "",
        `✅ **用户标注记忆**: ${userTyped} 条 (${((userTyped / total) * 100).toFixed(0)}%)`,
      );
    }

    return [{ type: "text", text: result_lines.join("\n") }];
  } else if (result.data) {
    return apiErrorResponse(
      "Stats",
      String(
        (result.data as Record<string, unknown>).message ?? "Unknown error",
      ),
    );
  } else {
    return apiErrorResponse("Stats", `HTTP ${result.status}`);
  }
}

// ============================================================================
// Helpers
// ============================================================================

export function extractMemoriesFromData(data: SearchData): MemoryNode[] {
  const memories: MemoryNode[] = [];
  const textMems = data.text_mem ?? [];
  for (const cubeData of textMems) {
    const memData = cubeData.memories;
    if (memData && !Array.isArray(memData) && memData.nodes) {
      memories.push(...memData.nodes);
    } else if (Array.isArray(memData)) {
      memories.push(...(memData as MemoryNode[]));
    }
  }
  return memories;
}

/**
 * memos_list_v2（Full 路径）的取数序列：提取 → 滤层级 → 滤业务类型 → 截断。
 *
 * 抽成导出的纯函数**只为让顺序可测**。这三步的次序不是随意的：
 *
 *   - 滤层级必须在 slice **之前**。放到之后，`limit` 会被随即隐藏的
 *     WorkingMemory 副本吃掉 —— 要 20 条只拿到 10 条。
 *   - slice 必须最后。它是对外承诺的输出上界。
 *
 * 之前这段逻辑内联在 handler 里，单测触达不到：实测切断层级过滤后
 * 全部 319 项 vitest 依然通过。这与 P1.5 的 W3/W4 是同一类漏洞
 * （见 docs/design/memory-retrieval-optimization.md 第 11 节）。
 * 在测试里自行组合这几步只能证明测试文件本身，证明不了 handler，
 * 所以必须让 handler 和测试调用同一个函数。
 */
export function prepareListMemories(
  data: SearchData,
  memoryType: string | undefined,
  limit: number,
): MemoryNode[] {
  const extracted = extractMemoriesFromData(data);
  const visible = [...filterEphemeralTier(extracted, (m) => m.metadata)];
  const typed = memoryType
    ? visible.filter((m) => extractMcpType(m) === memoryType)
    : visible;
  return typed.slice(0, limit);
}
