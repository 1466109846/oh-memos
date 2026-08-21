/**
 * 记忆层级（hierarchy）过滤。
 *
 * ## 两个正交的「类型」轴，容易混淆
 *
 * - `metadata.memory_type` —— **层级**：WorkingMemory / LongTermMemory / UserMemory。
 *   由 scheduler 管理，决定这条记录活多久。
 * - `metadata.type` / tags —— **业务类型**：DECISION / BUGFIX / GOTCHA…
 *   由 agent 在 memos_save 时指定。
 *
 * `memory-quality.ts` 用的是后者（PROGRESS 惩罚、半衰期分档）。本模块管前者。
 *
 * ## 为什么默认隐藏 WorkingMemory
 *
 * `manager.py` 的 `_add_memories_batch` 对每条记忆写**两个节点**：一个
 * WorkingMemory 副本 + 一个 LongTermMemory 图节点，内容逐字相同、
 * `created_at` 相同、UUID 不同。实测确认（三对全部一致）。
 *
 * 这是分层设计而非重复 —— WorkingMemory 是短期缓冲，由
 * `_cleanup_working_memory` 做 FIFO 淘汰；LongTermMemory 持久。两者都必需。
 *
 * 但把两层同时呈现给 agent 有两个问题：
 *   1. 看起来像同一条记忆出现两次（用户实测就是这样发现的）
 *   2. WorkingMemory 随时会被淘汰，让 agent 引用一个会消失的 id 是误导
 *
 * `handlers/wiki-export.ts` 早已做了同样的过滤并注明「scheduler-managed」。
 * 本模块把那个既有决策铺到 search 与 list 路径，不是引入新策略。
 *
 * 逃生开关：`MEMOS_SHOW_WORKING_MEMORY=true`。用环境变量而非工具参数 ——
 * schema budget 已接近上限，且这是调试用途，不该进 agent 可见的入参。
 *
 * 设计文档：docs/design/memory-retrieval-optimization.md 第 9.6 节
 */

/** 由 scheduler 管理、随时会被淘汰的层级。 */
const EPHEMERAL_TIER = "WorkingMemory";

/**
 * 该记录是否属于短期缓冲层。
 *
 * 缺失 `memory_type` 时返回 false（视为可见）—— Lite 模式的本地 JSONL
 * 根本不写这个字段，误判成 ephemeral 会让整个 Lite cube 变空。
 */
export function isEphemeralTier(metadata: unknown): boolean {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return String(meta.memory_type ?? "") === EPHEMERAL_TIER;
}

/**
 * 是否应该显示 WorkingMemory。默认否。
 *
 * 每次现读 env 而不缓存到模块常量：测试需要能改，且这不在热路径上。
 */
export function showsEphemeralTier(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return String(env.MEMOS_SHOW_WORKING_MEMORY ?? "").toLowerCase() === "true";
}

/**
 * 过滤掉短期缓冲层的记录。
 *
 * **全是 WorkingMemory 时原样返回。** 这种情况下过滤会让结果变空，
 * 而「一条都没有」对 agent 的伤害远大于「多了一层」—— 宁可漏一点噪声，
 * 不可把整个 cube 藏起来。真实成因：后端只写了 WorkingMemory，
 * 或 LongTermMemory 已被归档过滤掉。
 */
export function filterEphemeralTier<T>(
  items: readonly T[],
  getMetadata: (item: T) => unknown,
  env: NodeJS.ProcessEnv = process.env,
): readonly T[] {
  if (items.length === 0 || showsEphemeralTier(env)) return items;
  const kept = items.filter((item) => !isEphemeralTier(getMetadata(item)));
  return kept.length === 0 ? items : kept;
}
