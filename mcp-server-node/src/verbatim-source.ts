/**
 * 原文取回（verbatim source）。
 *
 * ## 为什么需要它
 *
 * `MOS_TYPED_SAVE_FAST=false` 时后端走 LLM 抽取：一次写入被切成多条记忆，每条的
 * `memory` 字段是 LLM 概括（约 200-250 字），而**逐字原文保存在
 * `metadata.sources[].content` 里**（实测：一条 877 字原文被切成 5 条，5 条的
 * sources 内容 sha 完全相同）。
 *
 * 于是同一份数据有两层，用途不同：
 *
 * | 层 | 内容 | 服务于 |
 * |---|---|---|
 * | `memory` | LLM 概括，细粒度 | 向量化与建边 —— 图谱节点质量、扩散联想 |
 * | `metadata.sources[].content` | 逐字原文 | `memos_get` —— 完整上下文 |
 *
 * 两者不冲突：抽取让图谱拿到细粒度节点（`memos_search` 的 ` via CAUSE from` 联想
 * 依赖它），而 `memos_get` 读 sources 就不丢原文。维护者的决定是「保证图谱节点
 * 编写分析，同时让 memos_get 拉原文」。
 *
 * ## 同源判定用内容指纹，不用 session_id
 *
 * 实测 5 条碎片的 `session_id` 相同 —— 但那是**整个 MCP 会话**的 id，一个会话里
 * 的多次无关写入会共享它，用它分组会把无关记忆归到一起。`created_at` 也不行：
 * 5 条各不相同（微秒级递增）。
 *
 * 只有 sources 内容本身是精确的分组键。
 *
 * ## fast-path 下本模块是无操作
 *
 * `MOS_TYPED_SAVE_FAST=true`（默认）时原样存储，`memory` 就是原文、`sources` 为空
 * → `verbatimOf()` 返回 null，渲染层保持原有行为。所以这套改动对两种模式都安全。
 *
 * 设计讨论见 docs/design/memory-retrieval-optimization.md。
 */

import type { MemoryNode } from "./types.js";

/** `metadata.sources[]` 的元素形态（后端 SourceMessage）。 */
interface SourceMessage {
  content?: unknown;
  type?: unknown;
  role?: unknown;
  chat_time?: unknown;
}

/**
 * 取出逐字原文。
 *
 * 没有 sources、sources 为空、或第一条没有非空 content 时返回 null —— 调用方据此
 * 判断「这条是 fast-path 存的，无需原文层」。
 *
 * 多条 sources 时用第一条：LLM 抽取路径下一次写入只产生一个 source（实测
 * `src_n=1`）。多条的情况来自 messages 数组写入，此时第一条仍是用户输入。
 */
export function verbatimOf(node: MemoryNode | undefined | null): string | null {
  const sources = (node?.metadata as Record<string, unknown> | undefined)
    ?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const first = sources[0] as SourceMessage | null | undefined;
  const content = first?.content;
  if (typeof content !== "string" || content.trim() === "") return null;
  return content;
}

/**
 * 同源指纹。同一次写入切出的碎片共享它。
 *
 * 直接用原文本身，不做哈希：这是进程内的分组键，不持久化也不跨机器比较，
 * 字符串相等就是精确判定。
 *
 * 初版加了 `${text.length}:` 前缀，理由是「让不同原文在第一个字符就分开」——
 * 变异验证时发现构造不出它能防住的碰撞（去掉前缀后 `abc` 与 `abcdef` 指纹依然
 * 不同），且 V8 的字符串相等本就先比长度。没有测试能支撑的防御代码比没有更糟，
 * 所以删掉。
 *
 * 无原文返回 null —— null 不参与分组，避免把所有 fast-path 记忆归成一组。
 */
export function sourceFingerprint(
  node: MemoryNode | undefined | null,
): string | null {
  return verbatimOf(node);
}

/** 同源碎片的展示条目。 */
export interface SiblingRef {
  id: string;
  key: string;
}

/** 渲染原文区块与同源碎片列表，供 `memos_get` 两条路径共用。 */
export function renderVerbatimSections(
  verbatim: string | null,
  siblings: readonly SiblingRef[],
  summary: string,
): string[] {
  if (verbatim === null) return [];
  const lines = ["", "### 原文 | Verbatim source", "", verbatim];

  // 概括也一并给出：它是向量化与建边的实际输入，看得见才能判断图谱节点切得对不对。
  if (summary.trim() !== "" && summary.trim() !== verbatim.trim()) {
    lines.push(
      "",
      "### 本节点的抽取概括 | Extracted summary (this node)",
      "",
      summary,
    );
  }

  if (siblings.length > 0) {
    lines.push(
      "",
      `### 同源节点 | Sibling nodes (${siblings.length})`,
      "",
      "同一份原文被 LLM 抽取切成的其他节点。原文在每条上都完整，无需逐条取回；",
      "这里列出是为了看清图谱节点的切分方式。",
      "Other nodes the same source was split into. Each carries the full source;",
      "listed so the graph-node segmentation is visible.",
      "",
    );
    for (const s of siblings) {
      lines.push(`- \`${s.id}\`${s.key ? ` — ${s.key}` : ""}`);
    }
  }

  return lines;
}

/**
 * 在候选集里找与 target 同源的其他碎片。
 *
 * 排除 target 自身，也排除没有原文的节点。顺序按候选集原顺序，由调用方决定
 * 候选集怎么排（后端返回顺序通常已按 created_at）。
 */
export function findSiblings(
  target: MemoryNode | undefined | null,
  candidates: readonly (MemoryNode | undefined | null)[],
  limit = 12,
): SiblingRef[] {
  const fp = sourceFingerprint(target);
  if (fp === null) return [];
  const targetId = String(target?.id ?? "");
  const out: SiblingRef[] = [];
  const seen = new Set<string>();
  for (const node of candidates) {
    if (out.length >= limit) break;
    const id = String(node?.id ?? "");
    if (!id || id === targetId || seen.has(id)) continue;
    if (sourceFingerprint(node) !== fp) continue;
    seen.add(id);
    const meta = (node?.metadata ?? {}) as Record<string, unknown>;
    const key = String(meta.key ?? "").trim();
    out.push({ id, key });
  }
  return out;
}
