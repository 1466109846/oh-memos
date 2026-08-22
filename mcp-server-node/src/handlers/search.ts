/**
 * Search Handlers
 *
 * memos_search, memos_search, memos_suggest, memos_context_resume
 */

import {
  MEMOS_URL,
  MEMOS_USER,
  NEO4J_HTTP_URL,
  NEO4J_USER,
  NEO4J_PASSWORD,
  MEMOS_MODE,
  MEMOS_CUBES_DIR,
  logger,
} from "../config.js";
import { getMemoryProvider } from "../providers/provider-factory.js";
import { apiCallWithRetry, fetchWithTimeout } from "../api-client.js";
import { ensureCubeRegistered } from "../cube-manager.js";
import { formatMemoriesForDisplay } from "../formatters.js";
import {
  COMPACTION_THRESHOLD,
  PREVIEW_COUNT,
  shouldCompact,
  compactedResultToText,
  toMinimal,
} from "../models.js";
import {
  applyKeywordRerank,
  detectQueryIntent,
  filterEdgesByIntent,
  filterMemoriesByType,
  getIntentDescription,
  parseMemoryTypePrefix,
} from "../query-processing.js";
import { suggestSearchQueries } from "../memory-analysis.js";
import { summarizeActiveCanvases } from "./canvas.js";
import { applyMemoryQualityPolicy } from "../memory-quality.js";
import type { QualityOptions } from "../memory-quality.js";
import { readAccessStats } from "../access-tracker.js";
import {
  buildSpreadCypher,
  mergeSpread,
  pickSeeds,
  rankNeighbours,
  rowToNeighbour,
  spreadEnabled,
  spreadRelativity,
  toSpreadNode,
} from "../spreading-activation.js";
import { filterEphemeralTier, showsEphemeralTier } from "../memory-tier.js";
import type { TextContent, MemoryNode, SearchData } from "../types.js";
import {
  apiErrorResponse,
  cubeRegistrationError,
  getCubeIdFromArgs,
} from "./utils.js";

/**
 * 检索排序策略的选项。
 *
 * 抽成一处是因为五条检索路径（Lite / Full / context-search / 两条 fallback）
 * 必须用同一套策略 —— 之前是同一段表达式复制五遍，改一处漏四处的风险很高。
 *
 * `accessStats` 每次现读：它来自本地侧车日志，读失败返回空 map，
 * 因此不需要错误处理，也不会让检索失败。
 */
function qualityOptions(cubeId: string, query: string): QualityOptions {
  return {
    mode: MEMOS_MODE,
    includeAutoCapture: /session|auto[-_ ]?capture/i.test(query),
    accessStats: readAccessStats(MEMOS_CUBES_DIR, cubeId),
  };
}

// ============================================================================
// Temporal Graph Query (Neo4j)
// ============================================================================

/**
 * Cypher for the recency query behind `memos_context_resume` and the
 * `temporal` search intent.
 *
 * ## 为什么必须在 Cypher 里排除 WorkingMemory，而不是在 handler 层
 *
 * 这个查询原先不 RETURN `memory_type`，构造出的 metadata 只有
 * `relativity`/`temporal_rank`/`source`。于是 `isEphemeralTier()` 永远读到
 * undefined 并判为可见 —— **下游任何分层过滤对 temporal 记忆都是空转**。
 *
 * 受害面是四个调用点，不只是 context_resume：
 *   - `memos_context_resume`（成对显示，用户实测发现）
 *   - `memos_search` 的 temporal intent 两处（经 applyMemoryQualityPolicy，
 *     过滤存在但读不到字段）
 *   - `memos_think`（同上）
 *
 * 在 Cypher 里滤还顺带避开超额取数：`LIMIT` 在过滤之后，要 10 条就得 10 条真
 * 记忆。若放到 handler 层，limit 会被随即隐藏的副本吃掉（这正是 §9.6 在 list
 * 路径踩过的顺序缺陷）。
 *
 * 同时 RETURN `memory_type`，让下游过滤从空转变成真的有落点 —— 双保险，
 * 且 `mergeTemporalResults` 之后的 quality policy 也能正确判层。
 *
 * 逃生开关 `MEMOS_SHOW_WORKING_MEMORY=true` 时不加这个条件，与
 * `filterEphemeralTier` 的语义保持一致。
 */
export function buildTemporalCypher(
  timeWindowHours?: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const timeFilter = timeWindowHours
    ? `AND n.updated_at >= datetime() - duration({hours: ${timeWindowHours}})`
    : "";
  const tierFilter = showsEphemeralTier(env)
    ? ""
    : "AND coalesce(n.memory_type, '') <> 'WorkingMemory'";
  return `
    MATCH (n:Memory)
    WHERE n.user_name = $user_name
    AND n.status = 'activated'
    ${timeFilter}
    ${tierFilter}
    RETURN n.id AS id, n.memory AS memory, n.key AS key,
           n.updated_at AS updated_at, n.background AS background,
           n.tags AS tags, n.memory_type AS memory_type
    ORDER BY n.updated_at DESC
    LIMIT $top_k
  `;
}

export async function getTemporalMemories(
  cubeId: string,
  topK = 10,
  timeWindowHours?: number,
): Promise<MemoryNode[]> {
  if (!NEO4J_HTTP_URL || !NEO4J_USER || !NEO4J_PASSWORD) {
    logger.debug("Neo4j config missing, skipping temporal query");
    return [];
  }

  const auth = Buffer.from(`${NEO4J_USER}:${NEO4J_PASSWORD}`).toString(
    "base64",
  );

  const cypher = buildTemporalCypher(timeWindowHours);

  try {
    const response = await fetchWithTimeout(NEO4J_HTTP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        statements: [
          {
            statement: cypher,
            parameters: { user_name: cubeId, top_k: topK },
          },
        ],
      }),
      timeoutMs: 10,
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      const errors = (data.errors as unknown[]) ?? [];
      if (errors.length > 0) {
        logger.warning(
          `Neo4j temporal query errors: ${JSON.stringify(errors)}`,
        );
        return [];
      }

      const rows =
        ((data.results as Record<string, unknown>[])?.[0]?.data as Record<
          string,
          unknown
        >[]) ?? [];
      const memories: MemoryNode[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const r = (row.row as unknown[]) ?? [];
        if (r.length >= 4) {
          memories.push({
            id: String(r[0] ?? ""),
            memory: String(r[1] ?? ""),
            key: String(r[2] ?? ""),
            updated_at: String(r[3] ?? ""),
            background: r.length > 4 ? String(r[4] ?? "") : "",
            tags: Array.isArray(r[5]) ? (r[5] as string[]) : [],
            metadata: {
              relativity: 0.8 - i * 0.05,
              temporal_rank: i + 1,
              source: "temporal_query",
              // 带上层级，否则下游 filterEphemeralTier 读到 undefined 而空转。
              // Cypher 已排除 WorkingMemory，这里是双保险 + 让 quality policy
              // 能正确判层。r[6] 可能缺失（旧节点没写该属性），留 undefined 即
              // 按可见处理，与 isEphemeralTier 的缺失语义一致。
              ...(r.length > 6 && r[6] != null
                ? { memory_type: String(r[6]) }
                : {}),
            },
          });
        }
      }

      logger.info(`Temporal query returned ${memories.length} memories`);
      return memories;
    }
  } catch (err) {
    logger.error(`Temporal query error: ${err}`);
  }
  return [];
}

// ============================================================================
// 一跳图扩散联想（P4）
// ============================================================================

/**
 * 对已命中的候选集做一跳扩散，把强关联记忆并入结果。
 *
 * **默认关闭**（`MEMOS_SPREAD_ACTIVATION=true` 开启）。任何失败都返回原
 * 候选集 —— 联想是增益不是必需，扩散失败不该让检索失败。
 *
 * 只在 Full 模式生效：Lite 无图，`NEO4J_HTTP_URL` 缺失时静默跳过。
 * 设计取舍见 spreading-activation.ts 文件头。
 */
async function applySpreadingActivation(
  data: SearchData,
  cubeId: string,
): Promise<SearchData> {
  if (!spreadEnabled()) return data;
  if (!NEO4J_HTTP_URL || !NEO4J_USER || !NEO4J_PASSWORD) return data;

  const existing = extractSearchMemories(data);
  const seeds = pickSeeds(existing);
  if (seeds.length === 0) return data;

  try {
    const auth = Buffer.from(`${NEO4J_USER}:${NEO4J_PASSWORD}`).toString(
      "base64",
    );
    const response = await fetchWithTimeout(NEO4J_HTTP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        statements: [
          {
            statement: buildSpreadCypher(),
            parameters: { seeds, user_name: cubeId },
          },
        ],
      }),
      timeoutMs: 10,
    });
    if (!response.ok) return data;

    const payload = (await response.json()) as Record<string, unknown>;
    if (((payload.errors as unknown[]) ?? []).length > 0) {
      logger.warning(
        `Spreading activation errors: ${JSON.stringify(payload.errors)}`,
      );
      return data;
    }

    const rows =
      ((payload.results as Record<string, unknown>[])?.[0]?.data as Record<
        string,
        unknown
      >[]) ?? [];
    const neighbours = rows
      .map((row) => rowToNeighbour((row.row as unknown[]) ?? []))
      .filter((n): n is NonNullable<typeof n> => n !== null);
    if (neighbours.length === 0) return data;

    const spread = rankNeighbours(neighbours).map((n) =>
      // relativity 依赖候选集：绝不压过任何直接命中（见 spreadRelativity）。
      toSpreadNode(n, spreadRelativity(existing)),
    );
    const merged = mergeSpread(existing, spread);
    logger.info(
      `Spreading activation: ${seeds.length} seeds → +${merged.length - existing.length} memories`,
    );
    return {
      text_mem: [
        {
          cube_id: "merged",
          memories: merged,
          _source: "spreading_activation",
        },
      ],
    };
  } catch (err) {
    logger.error(`Spreading activation failed: ${err}`);
    return data;
  }
}

function mergeTemporalResults(
  searchData: SearchData,
  temporalMemories: MemoryNode[],
  intent: string,
): SearchData {
  if (temporalMemories.length === 0) return searchData;

  const existingIds = new Set<string>();
  const textMem = searchData.text_mem ?? [];

  for (const bucket of textMem) {
    const memData = bucket.memories;
    const memories = Array.isArray(memData)
      ? (memData as MemoryNode[])
      : (memData?.nodes ?? []);
    for (const mem of memories) {
      const id = mem.id ?? (mem.metadata?.id as string);
      if (id) existingIds.add(id);
    }
  }

  const newTemporal = temporalMemories.filter((m) => !existingIds.has(m.id));
  if (newTemporal.length === 0) return searchData;

  if (intent === "temporal") {
    const temporalBucket = {
      cube_id: "temporal",
      memories: { nodes: newTemporal, edges: [] },
      _source: "temporal_graph_query",
    };
    searchData.text_mem = [temporalBucket, ...textMem];
  }

  return searchData;
}

function extractSearchMemories(data: SearchData): MemoryNode[] {
  const memories: MemoryNode[] = [];
  for (const cubeData of data.text_mem ?? []) {
    const memData = cubeData.memories;
    if (memData && !Array.isArray(memData) && memData.nodes) {
      memories.push(...memData.nodes);
    } else if (Array.isArray(memData)) {
      memories.push(...(memData as MemoryNode[]));
    }
  }
  return memories;
}

// ============================================================================
// memos_search
// ============================================================================

export async function handleMemosSearch(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  // context provided → context-aware path (formerly the memos_search tool)
  const ctx = arguments_.context;
  if (Array.isArray(ctx) && ctx.length > 0) {
    return handleMemosSearchContext(arguments_);
  }

  const cubeId = getCubeIdFromArgs(arguments_);
  const rawQuery = String(arguments_.query ?? "");
  const topK = Math.min(
    Number(arguments_.top_k ?? 10),
    MEMOS_MODE === "lite" ? 20 : 100,
  );
  const compact = arguments_.compact !== false;

  const [memType, cleanedQuery] = parseMemoryTypePrefix(rawQuery);
  const query = cleanedQuery || rawQuery;
  const intent = detectQueryIntent(query);

  const localProvider = getMemoryProvider(MEMOS_CUBES_DIR);
  if (localProvider) {
    let resultData = localProvider.toSearchData(
      cubeId,
      await localProvider.search(cubeId, query, topK),
    );
    resultData = filterMemoriesByType(resultData, memType);
    resultData = applyKeywordRerank(resultData, query);
    resultData = applyMemoryQualityPolicy(
      resultData,
      qualityOptions(cubeId, query),
    );
    const allMemories = extractSearchMemories(resultData);
    if (compact && shouldCompact(allMemories.length)) {
      return [
        {
          type: "text",
          text: compactedResultToText({
            preview: allMemories.slice(0, PREVIEW_COUNT).map(toMinimal),
            totalCount: allMemories.length,
            omittedCount: Math.max(0, allMemories.length - PREVIEW_COUNT),
            message: 'Use memos_get(memory_id="<id>") for full details',
            query: rawQuery,
            cubeId,
          }),
        },
      ];
    }
    return [{ type: "text", text: formatMemoriesForDisplay(resultData) }];
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  const apiResult = await apiCallWithRetry(
    "POST",
    `${MEMOS_URL}/search`,
    cubeId,
    {
      body: {
        user_id: MEMOS_USER,
        query,
        install_cube_ids: [cubeId],
        top_k: topK,
      },
    },
    ensureCubeRegistered,
  );

  if (apiResult.success && apiResult.data) {
    let resultData =
      ((apiResult.data as Record<string, unknown>).data as SearchData) ?? {};

    // Temporal enhancement
    if (intent === "temporal") {
      let timeWindow: number | undefined;
      const timeMatch = query.match(/(\d+)\s*(?:小时|hour|h)/i);
      if (timeMatch) timeWindow = parseInt(timeMatch[1]);
      else if (/今天|today/i.test(query)) timeWindow = 24;
      else if (/本周|this\s*week|week/i.test(query)) timeWindow = 168;

      const temporalMemories = await getTemporalMemories(
        cubeId,
        topK,
        timeWindow,
      );
      resultData = mergeTemporalResults(resultData, temporalMemories, intent);
    }

    resultData = filterEdgesByIntent(resultData, intent);
    resultData = filterMemoriesByType(resultData, memType);
    const keywordQuery = memType ? cleanedQuery : query;
    resultData = applyKeywordRerank(resultData, keywordQuery);
    resultData = applyMemoryQualityPolicy(
      resultData,
      qualityOptions(cubeId, query),
    );
    // 扩散在 policy 之后：种子应当是已排序的高分命中，而非原始候选。
    resultData = await applySpreadingActivation(resultData, cubeId);
    const allMemories = extractSearchMemories(resultData);
    const totalCount = allMemories.length;

    if (compact && shouldCompact(totalCount)) {
      const preview = allMemories.slice(0, PREVIEW_COUNT).map(toMinimal);
      let text = compactedResultToText({
        preview,
        totalCount,
        omittedCount: totalCount - preview.length,
        message: 'Use memos_get(memory_id="<id>") for full details',
        query: rawQuery,
        cubeId,
      });

      if (intent !== "default") {
        const intentDesc = getIntentDescription(intent);
        text = `*${intentDesc}*\n\n${text}`;
      }

      return [{ type: "text", text }];
    }

    let formatted = formatMemoriesForDisplay(resultData);
    if (intent !== "default") {
      const intentDesc = getIntentDescription(intent);
      formatted = `*${intentDesc}*\n\n${formatted}`;
    }

    return [{ type: "text", text: formatted }];
  } else if (apiResult.data) {
    return apiErrorResponse(
      "Search",
      String(
        (apiResult.data as Record<string, unknown>).message ?? "Unknown error",
      ),
    );
  } else {
    return apiErrorResponse("Search", `HTTP ${apiResult.status}`);
  }
}

// ============================================================================
// memos_search
// ============================================================================

export async function handleMemosSearchContext(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const rawQuery = String(arguments_.query ?? "");
  const context = (arguments_.context as Array<Record<string, string>>) ?? [];

  const [memType, cleanedQuery] = parseMemoryTypePrefix(rawQuery);
  const query = cleanedQuery || rawQuery;

  const contextText = context
    .slice(-5)
    .map((m) => m.content ?? "")
    .join(" ");
  const intent = detectQueryIntent(`${query} ${contextText}`);

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  try {
    const response = await fetchWithTimeout(`${MEMOS_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: MEMOS_USER,
        query,
        install_cube_ids: [cubeId],
        top_k: 15,
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>;
      if (data.code === 200) {
        const results: string[] = [];
        const intentDesc = getIntentDescription(intent);
        results.push(`## ${intentDesc}`, "");

        let resultData = (data.data as SearchData) ?? {};

        if (intent === "temporal") {
          const temporalMemories = await getTemporalMemories(cubeId, 15);
          resultData = mergeTemporalResults(
            resultData,
            temporalMemories,
            intent,
          );
        }

        resultData = filterEdgesByIntent(resultData, intent);
        resultData = filterMemoriesByType(resultData, memType);
        const keywordQuery = memType ? cleanedQuery : query;
        resultData = applyKeywordRerank(resultData, keywordQuery);
        resultData = applyMemoryQualityPolicy(
          resultData,
          qualityOptions(cubeId, query),
        );
        // 扩散在 policy 之后：种子应当是已排序的高分命中，而非原始候选。
        resultData = await applySpreadingActivation(resultData, cubeId);
        const formatted = formatMemoriesForDisplay(resultData);

        if (context.length > 0) {
          results.push(
            `*Analyzed with ${context.length} context messages*`,
            "",
          );
        }
        results.push(formatted);
        return [{ type: "text", text: results.join("\n") }];
      } else {
        // Fallback to standard search
        const fallbackResult = await apiCallWithRetry(
          "POST",
          `${MEMOS_URL}/search`,
          cubeId,
          { body: { user_id: MEMOS_USER, query, install_cube_ids: [cubeId] } },
          ensureCubeRegistered,
        );
        if (fallbackResult.success && fallbackResult.data) {
          let resultData =
            ((fallbackResult.data as Record<string, unknown>)
              .data as SearchData) ?? {};
          resultData = filterEdgesByIntent(resultData, intent);
          resultData = filterMemoriesByType(resultData, memType);
          const keywordQuery = memType ? cleanedQuery : query;
          resultData = applyKeywordRerank(resultData, keywordQuery);
          resultData = applyMemoryQualityPolicy(
            resultData,
            qualityOptions(cubeId, query),
          );
          // 扩散在 policy 之后：种子应当是已排序的高分命中，而非原始候选。
          resultData = await applySpreadingActivation(resultData, cubeId);
          const formatted = formatMemoriesForDisplay(resultData);
          return [
            {
              type: "text",
              text: `## Search Results (fallback)\n\n${formatted}`,
            },
          ];
        }
        return apiErrorResponse(
          "Context search",
          String(data.message ?? "Unknown error"),
        );
      }
    } else {
      return apiErrorResponse("Context search", `HTTP ${response.status}`);
    }
  } catch (err) {
    return apiErrorResponse("Context search", String(err));
  }
}

// ============================================================================
// memos_suggest
// ============================================================================

/**
 * The memory_type decision tree.
 *
 * This used to live in `memos_save`'s description, where it was the single most
 * expensive item on the tool surface (1214 B) — and it was paid on *every*
 * turn, whether or not anything was ever saved. Here it is paid only when the
 * model actually asks, which is precisely when it is useful. `memos_save` keeps
 * a one-line type mapping plus a pointer to this tool.
 */
const MEMORY_TYPE_DECISION_TREE = [
  "## 🧭 memory_type 决策树",
  "",
  "按优先级选择,PROGRESS 排在最后:",
  "",
  "- **ERROR_PATTERN** — 错误签名 + 解法(有通用复用价值,换个项目也可能撞上)",
  "- **BUGFIX** — 本项目一次性的缺陷修复,含成因与解法",
  "- **DECISION** — 架构或设计选择,**必须写明理由**",
  "- **GOTCHA** — 非显而易见的陷阱或绕行方案",
  "- **CODE_PATTERN** — 可复用的代码模板",
  "- **CONFIG** — 环境或配置变更",
  "- **FEATURE** — 新增的功能",
  "- **MILESTONE** — 重要的阶段性成果",
  "- **SYNTHESIS** — 由 memos_think 证据合成的答案页(二手综合,不用于记录一手事实)",
  "- **PROGRESS** — **仅用于纯进度更新**;禁止包含错误解决方案、技术决策、陷阱警告",
  "",
  "拿不准时的判据:这条记忆将来会被谁、在什么处境下搜到?",
  "按那个处境选类型,而不是按写它时的心情。",
].join("\n");

export async function handleMemosSuggest(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const context = String(arguments_.context ?? "");
  const suggestions = suggestSearchQueries(context);

  const parts: string[] = [];

  if (suggestions.length > 0) {
    parts.push(
      "## 🔍 Suggested Searches\n",
      "Based on your context, try these searches:\n",
    );
    for (let i = 0; i < suggestions.length; i++) {
      parts.push(`${i + 1}. \`${suggestions[i]}\``);
    }
  } else {
    parts.push(
      "No specific suggestions. Try searching with keywords from your context.",
    );
  }

  parts.push("", "---", "", MEMORY_TYPE_DECISION_TREE);

  return [{ type: "text", text: parts.join("\n") }];
}

function renderContextResume(
  cubeId: string,
  recentMemories: MemoryNode[],
): TextContent[] {
  const lines = ["## Context Resumed", ""];
  const canvasLines = summarizeActiveCanvases(cubeId);
  if (canvasLines.length > 0) lines.push(...canvasLines);
  if (recentMemories.length > 0) {
    lines.push(
      `**Recent memories** (${recentMemories.length} items, last 24h):`,
      "",
    );
    for (let i = 0; i < Math.min(recentMemories.length, RESUME_LIMIT); i++)
      lines.push(
        `${i + 1}. ${(recentMemories[i].memory ?? "").slice(0, 120).split("\n")[0]}`,
      );
  } else lines.push("No recent memories found in this cube.");
  lines.push(
    "",
    "---",
    "**REMINDER**: Use MCP memos tools for ALL memory operations.",
    "NEVER use `mkdir` or `Write` to create memory files.",
  );
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * 分层过滤 + 截断，供 `memos_context_resume` 两条路径共用。
 *
 * ## 顺序要紧：滤层级必须在 slice 之前
 *
 * 放到之后，`limit` 会被随即隐藏的 WorkingMemory 副本吃掉 —— 要 10 条只拿到
 * 5 条（用户实测就是 10 条里 5 对）。与 `prepareListMemories` 同形，
 * 那处已经因为同样的原因栽过一次。
 *
 * ## 为什么必须是导出的函数
 *
 * 原先这段逻辑内联在 handler 里，单测触达不到 —— §9.6 与 P1.5 已两次证明：
 * 切断 handler 内联逻辑时全部单测仍然通过。在测试里自行组合只能证明测试文件，
 * 证明不了 handler。所以 handler 与测试必须调用**同一个**函数。
 */
export function prepareResumeMemories(
  memories: readonly MemoryNode[],
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): MemoryNode[] {
  const visible = filterEphemeralTier(memories, (m) => m.metadata, env);
  return [...visible].slice(0, limit);
}

/** `memos_context_resume` 显示的条数上限。 */
const RESUME_LIMIT = 10;

/**
 * 取数时的超额系数。
 *
 * API 回退路径的 limit 由服务端施加，过滤只能在取回之后做，所以必须多取 ——
 * 每条记忆恰好有一个 WorkingMemory 副本，2 倍即可覆盖，取 3 倍留余量
 * （旧节点可能没有副本，多取的部分会被 slice 丢掉，无副作用）。
 *
 * temporal 路径不需要这个：Cypher 的 LIMIT 在过滤之后。
 */
const RESUME_OVERFETCH = 3;

export async function handleMemosContextResume(
  arguments_: Record<string, unknown>,
): Promise<TextContent[]> {
  const cubeId = getCubeIdFromArgs(arguments_);
  const localProvider = getMemoryProvider(MEMOS_CUBES_DIR);
  if (localProvider) {
    // Lite 的 JSONL 不写 memory_type，filterEphemeralTier 按缺失即可见处理，
    // 所以这里过滤是空操作 —— 保留它是为了后端哪天开始写该字段时自动生效。
    const recentMemories = await localProvider.recent(cubeId, 24, RESUME_LIMIT);
    return renderContextResume(
      cubeId,
      prepareResumeMemories(recentMemories, RESUME_LIMIT),
    );
  }

  const [regSuccess, regError] = await ensureCubeRegistered(cubeId);
  if (!regSuccess) return cubeRegistrationError(cubeId, regError);

  // Try temporal query first. Cypher 已排除 WorkingMemory 且 LIMIT 在过滤之后，
  // 所以按原样取 RESUME_LIMIT 条就是 RESUME_LIMIT 条真记忆。
  let recentMemories = await getTemporalMemories(cubeId, RESUME_LIMIT, 24);

  // Fallback to API list
  if (recentMemories.length === 0) {
    const result = await apiCallWithRetry(
      "GET",
      `${MEMOS_URL}/memories`,
      cubeId,
      {
        params: {
          user_id: MEMOS_USER,
          mem_cube_id: cubeId,
          // 超额取：服务端施加 limit，过滤只能在取回后做，不多取则 limit 被
          // 随即隐藏的副本吃掉。
          limit: RESUME_LIMIT * RESUME_OVERFETCH,
        },
      },
      ensureCubeRegistered,
    );
    if (result.success && result.data) {
      recentMemories = extractSearchMemories(
        ((result.data as Record<string, unknown>).data as SearchData) ?? {},
      );
    }
  }

  recentMemories = prepareResumeMemories(recentMemories, RESUME_LIMIT);

  const lines = ["## Context Resumed", ""];

  // Unfinished task canvases come first: after a compaction, "where was I" is
  // more urgent than "what do we know". Headlines only — the model opens what it
  // needs with memos_canvas(action="show").
  const canvasLines = summarizeActiveCanvases(cubeId);
  if (canvasLines.length > 0) lines.push(...canvasLines);

  if (recentMemories.length > 0) {
    lines.push(
      `**Recent memories** (${recentMemories.length} items, last 24h):`,
      "",
    );
    for (let i = 0; i < Math.min(recentMemories.length, RESUME_LIMIT); i++) {
      const mem = recentMemories[i];
      const content = mem.memory ?? "";
      const summary = content.slice(0, 120).split("\n")[0];
      lines.push(`${i + 1}. ${summary}`);
    }
    lines.push("");
  } else {
    lines.push("No recent memories found in this cube.", "");
  }

  lines.push("---");
  lines.push(
    "**REMINDER**: Use MCP memos tools (`memos_save`, `memos_search`) for ALL memory operations.",
  );
  lines.push("NEVER use `mkdir` or `Write` to create memory files.");

  return [{ type: "text", text: lines.join("\n") }];
}
