import type { MemoryNode, SearchData } from "./types.js";
import { filterEphemeralTier } from "./memory-tier.js";
import { isSpreadNode } from "./spreading-activation.js";

export type MemoryMode = "full" | "lite";

export interface QualityOptions {
  mode?: MemoryMode;
  now?: number;
  includeAutoCapture?: boolean;
  /** 折叠近重复记忆。默认开启 —— 被折叠项的 id 保留在 metadata，信息不丢。 */
  dedupe?: boolean;
  /** 近重复判定阈值（字符 n-gram Jaccard），默认 0.82。调低会更激进。 */
  dedupeThreshold?: number;
  /**
   * 本机访问统计，来自 access-tracker。提供时用于填充 reinforcement 项 ——
   * 记忆记录自身不带 access_count，使用度是本机侧车数据。
   * 记录里已有的 access_count 优先，便于后端将来自行提供该字段。
   */
  accessStats?: ReadonlyMap<string, { count: number; lastAt: string }>;
  /** 覆盖环境变量，仅供测试注入 `MEMOS_SHOW_WORKING_MEMORY`。 */
  env?: NodeJS.ProcessEnv;
}

function meta(node: MemoryNode): Record<string, unknown> {
  return (node.metadata ?? {}) as Record<string, unknown>;
}

function tags(node: MemoryNode): string[] {
  const value = node.tags ?? meta(node).tags;
  return Array.isArray(value) ? value.map(String) : [];
}

function isAutoCapture(node: MemoryNode): boolean {
  return (
    tags(node).some((tag) => tag.toLowerCase() === "auto-capture") ||
    meta(node).capture_stage === "auto"
  );
}

function ageDays(node: MemoryNode, now: number): number | null {
  const raw =
    node.updated_at ??
    node.created_at ??
    String(meta(node).updated_at ?? meta(node).created_at ?? "");
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : Math.max(0, (now - parsed) / 86_400_000);
}

/**
 * 夹到 [0,1]，非有限值回退到 fallback。
 *
 * 裸写 Math.max(0, Math.min(1, x)) 不防 NaN —— Math.min(1, NaN) 是 NaN，
 * Math.max(0, NaN) 还是 NaN，最终 quality_score 变成 NaN 且排序不可预测。
 * 脏输入的现实来源：后端把 confidence 传成非数值字符串。
 */
function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/**
 * 按 memory_type 分档的半衰期（天）。
 *
 * 分档理由：CONFIG 会随环境漂移（端口/路径/版本号会过时），DECISION 与 GOTCHA
 * 是原理性知识、多年有效。用同一条曲线衰减两者属于建模不足。
 * 详见 docs/design/memory-retrieval-optimization.md 第 6.1 节。
 */
const HALF_LIFE_DAYS: Readonly<Record<string, number>> = Object.freeze({
  PROGRESS: 14, // 纯进度汇报；另有 7 天 TTL 归档兜底
  CONFIG: 180, // 配置会变
  ERROR_PATTERN: 365, // 与代码版本绑定
  BUGFIX: 365,
  FEATURE: 540, // 事实性记录，会被后续里程碑取代
  MILESTONE: 540,
  DECISION: 1095, // 原理性知识
  GOTCHA: 1095,
  CODE_PATTERN: 1095,
  SYNTHESIS: 1095, // 巩固产物，与原理性知识同档
});

/** 未知/缺失类型的中位保守值。 */
const DEFAULT_HALF_LIFE_DAYS = 365;

/**
 * 衰减下限。取 0.05 而非 0.55 —— 允许充分衰减，但不归零，
 * 保留旧记忆被访问强化唤回的可能。
 */
const FRESHNESS_FLOOR = 0.05;

/** 访问强化的饱和点：命中这么多次即达满值。 */
const REINFORCE_SATURATION = 20;

/**
 * relativity 缺失时的回退值。
 *
 * 取 0.35 而非中位 0.5：缺字段应当是惩罚而非中性，否则一条完全不相关的记忆
 * 靠 confidence 默认值就能挤进 top_k。不直接取 0，避免历史记忆全部沉底。
 */
const SEMANTIC_MISSING = 0.35;

function halfLifeDays(type: string): number {
  return HALF_LIFE_DAYS[type] ?? DEFAULT_HALF_LIFE_DAYS;
}

function parseAgeDays(raw: unknown, now: number): number | null {
  const parsed = Date.parse(String(raw ?? ""));
  return Number.isNaN(parsed) ? null : Math.max(0, (now - parsed) / 86_400_000);
}

/**
 * 计入访问时间的有效年龄：min(距上次更新, 距上次访问)。
 *
 * 近期被检索命中过的记忆按访问时间算新鲜度 —— 「用则强化，不用则衰减」，
 * 是 ACT-R base-level activation 的简化形式。
 */
function effectiveAgeDays(node: MemoryNode, now: number): number | null {
  const updateAge = ageDays(node, now);
  const accessAge = parseAgeDays(meta(node).last_accessed_at, now);
  if (updateAge === null) return accessAge;
  if (accessAge === null) return updateAge;
  return Math.min(updateAge, accessAge);
}

/**
 * 访问强化项，对数饱和到 [0,1]。
 *
 * 用对数而非线性：避免高频记忆垄断排序，同时让「用过一次」与「从未用过」
 * 之间有明显区分 —— 这一段的边际收益最大。
 */
function reinforcement(node: MemoryNode): number {
  const raw = Number(meta(node).access_count);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(1, Math.log1p(raw) / Math.log1p(REINFORCE_SATURATION));
}

export function memoryQualityScore(node: MemoryNode, now = Date.now()): number {
  const m = meta(node);
  const semantic = clamp01(m.relativity ?? SEMANTIC_MISSING, SEMANTIC_MISSING);
  const confidence =
    m.confidence === undefined ? 0.7 : clamp01(m.confidence, 0.7);
  const type = String(m.type ?? "");
  const progressPenalty = type === "PROGRESS" ? 0.82 : 1;
  const autoPenalty = isAutoCapture(node) ? 0.45 : 1;
  const statusPenalty =
    String(m.status ?? "activated") === "activated" ? 1 : 0.25;

  // 指数衰减，半衰期按类型分档。旧实现是 max(0.55, 1 - age/3650) ——
  // 十年才掉 45% 且永不归零，一年的时间差在总分里只值 0.0027，实际等于不衰减。
  const age = effectiveAgeDays(node, now);
  const freshness =
    age === null
      ? 1
      : Math.max(FRESHNESS_FLOOR, Math.pow(0.5, age / halfLifeDays(type)));

  const reinforce = reinforcement(node);
  const expiresAt = Date.parse(String(m.expires_at ?? ""));
  const expiredPenalty = Number.isNaN(expiresAt) || expiresAt > now ? 1 : 0.2;

  // 权重和恒为 1.0，由 memory-quality-baseline.test.ts 的「权重和守卫」断言。
  //
  // freshness 与 reinforce 的预算取自 semantic 与 confidence，**不动三个惩罚项**。
  // 惩罚项编码的是产品策略（auto-capture 不可信、archived 已退役），
  // 不应因为新增信号而被稀释 —— 那是静默的行为变化。
  // 从 confidence 让出更多：它是 LLM 赋值的主观信号，噪声高于 freshness 这类客观量。
  const baseScore =
    semantic * 0.5 +
    confidence * 0.15 +
    freshness * 0.14 +
    reinforce * 0.06 +
    progressPenalty * 0.05 +
    autoPenalty * 0.05 +
    statusPenalty * 0.05;
  // 最终夹取：权重和为 1 但浮点累加会溢出到 1.0000000000000002，
  // 而 [0,1] 是本函数的对外契约（下游按区间解读，也用于排序阈值）。
  return Math.max(0, Math.min(1, baseScore * expiredPenalty));
}

// ============================================================================
// 近重复折叠
//
// 原有去重只在 Python 侧 searcher.py 按 memory 文本**精确匹配**，措辞略有差异的
// 三条同义记忆会全部返回、挤占 top_k 预算。这里在 node 层的 quality policy 内做，
// 一次覆盖 Lite / Full / context-search / fallback 全部检索路径。
// ============================================================================

/**
 * 近重复判定阈值，**按 memory_type 分档**。
 *
 * 维护者决定（2026-08-22）：不用单一阈值，因为不同类型对"措辞略异"的容忍度
 * 本质不同 —— 进度汇报本就重复，原理性内容差一个字可能差很多。
 *
 * | 档位 | 类型 | 理由 |
 * |---|---|---|
 * | 0.70 激进 | `PROGRESS` | 进度汇报本就重复，同一件事没必要都占 top_k |
 * | 0.78 中等 | `MILESTONE` / `FEATURE` | 事实性记录 |
 * | 0.82 现状 | `BUGFIX` / `ERROR_PATTERN` / `CONFIG` | 与代码/环境绑定，中间偏保守 |
 * | 0.88 保守 | `DECISION` / `GOTCHA` / `CODE_PATTERN` / `SYNTHESIS` | 原理性内容 |
 *
 * `dedupeThreshold` 选项若显式给出则覆盖全部分档 —— 供测试与调参用。
 */
const DEDUPE_THRESHOLD_BY_TYPE: Readonly<Record<string, number>> =
  Object.freeze({
    PROGRESS: 0.7,
    MILESTONE: 0.78,
    FEATURE: 0.78,
    BUGFIX: 0.82,
    ERROR_PATTERN: 0.82,
    CONFIG: 0.82,
    DECISION: 0.88,
    GOTCHA: 0.88,
    CODE_PATTERN: 0.88,
    SYNTHESIS: 0.88,
  });

/** 未知/缺失类型的阈值。取中间档，与改动前的单一阈值一致。 */
const DEDUPE_THRESHOLD = 0.82;

function dedupeThresholdFor(type: string): number {
  return DEDUPE_THRESHOLD_BY_TYPE[type] ?? DEDUPE_THRESHOLD;
}

/** 字符 n-gram 长度。 */
const SHINGLE_SIZE = 4;

/** 短于此长度的正文改用精确匹配 —— n-gram 在极短串上不稳定。 */
const MIN_SHINGLE_LENGTH = 12;

/**
 * 归一化正文用于比较：去 markdown 标记与标点，压缩空白，转小写。
 *
 * 不做分词。本项目记忆以中文为主，中文没有词边界，按空格分词会退化成
 * 「整段算一个 token」，Jaccard 恒为 0 或 1。字符 n-gram 对中英文都成立。
 */
function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~#>[\]()]/g, "")
    .replace(/[\s　]+/g, " ")
    .replace(/[.,;:!?，。；：！？、—-]/g, "")
    .trim();
}

function shingles(text: string, size = SHINGLE_SIZE): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= text.length; i += 1)
    out.add(text.slice(i, i + size));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

interface DedupeCandidate {
  node: MemoryNode;
  normalized: string;
  grams: Set<string>;
  type: string;
}

function toCandidate(node: MemoryNode): DedupeCandidate {
  const normalized = normalizeForCompare(String(node.memory ?? ""));
  return {
    node,
    normalized,
    grams: shingles(normalized),
    type: String(meta(node).type ?? ""),
  };
}

/**
 * 判定近重复。
 *
 * `override` 给出时用它，否则按 `a.type` 取分档阈值 —— 两者 type 必然相同
 * （下面第一条就排除了跨类型），所以取 a 或 b 无差别。
 */
function isNearDuplicate(
  a: DedupeCandidate,
  b: DedupeCandidate,
  override?: number,
): boolean {
  // 不跨类型折叠：同一件事的 BUGFIX 与 DECISION 是不同产物，合并会丢语义。
  if (a.type !== b.type) return false;
  // 空正文永不参与折叠 —— 否则所有缺 memory 字段的节点会被合成一条。
  if (a.normalized.length === 0 || b.normalized.length === 0) return false;
  if (
    a.normalized.length < MIN_SHINGLE_LENGTH ||
    b.normalized.length < MIN_SHINGLE_LENGTH
  ) {
    return a.normalized === b.normalized;
  }
  const threshold = override ?? dedupeThresholdFor(a.type);
  return jaccard(a.grams, b.grams) >= threshold;
}

/**
 * 折叠近重复。输入必须已按分数降序 —— 先到者即高分者，予以保留。
 *
 * O(n·k)，n 为候选数、k 为保留数。检索结果规模（top_k 量级）下无需 MinHash。
 */
function foldNearDuplicates(
  ranked: MemoryNode[],
  override?: number,
): MemoryNode[] {
  const kept: DedupeCandidate[] = [];
  const folded = new Map<DedupeCandidate, string[]>();
  for (const node of ranked) {
    const candidate = toCandidate(node);
    const match = kept.find((k) => isNearDuplicate(k, candidate, override));
    if (match) {
      folded.set(match, [...(folded.get(match) ?? []), String(node.id ?? "")]);
      continue;
    }
    kept.push(candidate);
  }
  return kept.map((candidate) => {
    const ids = folded.get(candidate);
    if (!ids || ids.length === 0) return candidate.node;
    // 只在真的折叠了东西时才写这两个键，避免给每条结果塞噪声字段。
    return {
      ...candidate.node,
      metadata: {
        ...meta(candidate.node),
        duplicates_folded: ids,
        duplicates_folded_count: ids.length,
      },
    };
  });
}

/**
 * 把本机访问统计注入节点 metadata，供 reinforcement 项使用。
 *
 * 记录里已存在的 `access_count` 优先 —— 后端将来若自行提供该字段，
 * 它比本机侧车更权威，不应被覆盖。
 */
function withAccessStats(
  node: MemoryNode,
  stats: QualityOptions["accessStats"],
): MemoryNode {
  if (!stats || stats.size === 0) return node;
  const existing = meta(node).access_count;
  if (existing !== undefined) return node;
  const hit = stats.get(String(node.id ?? ""));
  if (!hit) return node;
  return {
    ...node,
    metadata: {
      ...meta(node),
      access_count: hit.count,
      last_accessed_at: hit.lastAt,
    },
  };
}

function extract(data: SearchData): MemoryNode[] {
  const out: MemoryNode[] = [];
  for (const bucket of data.text_mem ?? []) {
    const memories = bucket.memories;
    if (Array.isArray(memories)) out.push(...(memories as MemoryNode[]));
    else if (memories?.nodes) out.push(...memories.nodes);
  }
  return out;
}

export function applyMemoryQualityPolicy(
  data: SearchData,
  options: QualityOptions = {},
): SearchData {
  const now = options.now ?? Date.now();
  const includeAuto = options.includeAutoCapture === true;
  // 先滤层级再打分：WorkingMemory 是 scheduler 管理的短期副本，与
  // LongTermMemory 内容逐字相同，同时呈现会看起来像同一条记忆出现两次。
  // 详见 memory-tier.ts。
  const visible = filterEphemeralTier(
    extract(data),
    (node) => node.metadata,
    options.env,
  );
  const candidates = visible.filter(
    (node) => !(options.mode === "lite" && isAutoCapture(node) && !includeAuto),
  );
  const ranked = candidates
    .map((raw) => {
      // 先注入本机访问统计，再打分 —— 记录自身不带这些字段。
      const node = withAccessStats(raw, options.accessStats);
      const score = memoryQualityScore(node, now);
      const m = { ...meta(node) };
      const age = ageDays(node, now);
      const expires = Date.parse(String(m.expires_at ?? ""));
      m.quality_score = Number(score.toFixed(6));
      m.freshness =
        !Number.isNaN(expires) && expires <= now
          ? "expired"
          : age !== null && age > 365
            ? "stale"
            : "fresh";
      return { ...node, metadata: m };
    })
    .sort((a, b) => {
      // 分层：直接命中恒在联想之前。
      //
      // 维护者决定（[DECISION] a4b3ed39）：「弱匹配也是匹配，联想不是」。
      // 这条**必须在排序层强制**，压低扩散节点的 relativity 做不到 ——
      // quality_score 是六项加权和，联想节点若 updated_at 很新（邻居可能
      // 是今天保存的），freshness 拿满分就能反超陈旧的直接命中。
      //
      // 实测反例（修此缺陷前）：
      //   陈旧直接命中 relativity 0.9 / PROGRESS / 400 天 → score 0.7030
      //   新鲜联想节点 relativity 0.89 / 今天             → score 0.8400
      // 联想赢了 —— 决定被违反。约束输入代理不等于约束最终顺序。
      const spreadA = isSpreadNode(a) ? 1 : 0;
      const spreadB = isSpreadNode(b) ? 1 : 0;
      if (spreadA !== spreadB) return spreadA - spreadB;
      return (
        Number(b.metadata?.quality_score ?? 0) -
        Number(a.metadata?.quality_score ?? 0)
      );
    });
  // 折叠必须在排序之后 —— foldNearDuplicates 依赖「先到者即高分者」来决定保留哪条。
  const deduped =
    options.dedupe === false
      ? ranked
      : // 不传 dedupeThreshold 时按类型分档；显式给出则覆盖全部分档。
        foldNearDuplicates(ranked, options.dedupeThreshold);
  return {
    text_mem: [
      { cube_id: "merged", memories: deduped, _source: "quality_policy" },
    ],
  };
}
