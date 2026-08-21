/**
 * 一跳图扩散联想（P4）。
 *
 * ## 构想来源
 *
 * 这是「LLM agent 能否像人脑那样联想」那条讨论的实际落点。全息表示（HRR）
 * 天然支持联想检索，但代价是**叠加容量与干扰**：arXiv 2606.24948 证明多跳
 * 组合会失败，且干扰在单跳时就已存在；更要紧的是全息叠加**做不到删掉单条
 * 记忆** —— 而 GDPR 式的删除需求要求做到。
 *
 * 图扩散是 localist 存储实现联想的方式：**既避开叠加容量瓶颈，又保留逐条
 * 删除能力**。理论支撑是 *The Library Theorem*（arXiv 2603.21272）——
 * 索引化外部记忆相对顺序扫描有指数级检索优势。
 *
 * ## 前置测量（jincaizhaopin_cube，6534 节点 / 9133 条 typed 边）
 *
 * 实现前量过五项，全部支持做这件事：
 *
 * | 指标 | 实测 | 含义 |
 * |---|---|---|
 * | 边覆盖 | 6430/6534 = 98.4% | 扩散不会大面积空转 |
 * | 一跳候选规模 | 中位 10、p90 33、最大 75 | 可用，但需上界 |
 * | 跨业务类型边 | 2581/9133 = 28% | 带回新种类信息，非同类堆叠 |
 * | 邻居专属率 | 72% 只被 1 个源共享 | **不需要 hub 抑制** |
 * | 最强 hub | 仅被 61/3039 源共享（2%） | 无强 hub |
 *
 * 随机抽 6 个度数 5-20 的 `fact`，**邻居集完全零重叠** —— 从不同记忆扩散
 * 带回的是不同的东西，不是同一批噪声。这一条否决了我实现前的 hub 稀释担忧。
 *
 * ## 设计取舍
 *
 * - **只扩散一跳。** 2606.24948 的负面结果是多跳组合失败；那是全息表示的
 *   结论，但图上多跳同样会让相关性快速衰减，且候选集爆炸（一跳中位 10，
 *   两跳就是 100 量级）。一跳是有实测支撑的深度。
 * - **上界 12。** 覆盖中位 10 到 p90 33 之间。388 个 31+ 度节点必须截断，
 *   否则单次命中就能灌满 top_k。
 * - **边类型优先级 `CAUSE` > `CONDITION` > `RELATE`。** 因果与条件比泛关联
 *   更可能是 agent 想要的；截断时先保留前者。
 * - **扩散结果打标记且不参与二次扩散。** 可解释性优先：agent 应当看得出
 *   哪条是直接命中、哪条是联想带回的，以及经由什么边。
 * - **只在 Full 模式生效。** Lite 无图，`NEO4J_HTTP_URL` 缺失时静默跳过。
 *
 * 设计文档：docs/design/memory-retrieval-optimization.md 第 9 节
 */
import type { MemoryNode } from "./types.js";

/**
 * 是否启用扩散。**默认关闭。**
 *
 * 与 `MEMOS_SHOW_WORKING_MEMORY` 同一模式：用环境变量而非工具参数 ——
 * schema budget 接近上限，且这是部署级策略而非单次调用的选项。
 *
 * 默认关闭的理由：扩散会改变每次检索的返回内容（多带回最多 12 条旁证）。
 * 前置测量支持它有效，但「有效」不等于「所有场景都想要」—— 精确查找时
 * 多出来的联想是干扰。让部署方显式开启，而不是替他们决定。
 */
export function spreadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MEMOS_SPREAD_ACTIVATION ?? "").toLowerCase() === "true";
}

/** 参与扩散的边类型，按优先级降序 —— 截断时靠前者优先保留。 */
export const SPREAD_EDGE_TYPES = ["CAUSE", "CONDITION", "RELATE"] as const;

/** 一次检索最多带回的联想节点数。取值理由见文件头的前置测量。 */
export const SPREAD_LIMIT = 12;

/** 标在扩散所得节点上的 metadata 键。 */
export const SPREAD_VIA_KEY = "spread_via";
export const SPREAD_FROM_KEY = "spread_from";

export interface SpreadNeighbour {
  id: string;
  memory: string;
  key?: string;
  tags?: string[];
  updated_at?: string;
  /** 经由的边类型。 */
  via: string;
  /** 从哪个已命中节点扩散而来。 */
  from: string;
  /** 该邻居自身的度数，用于抑制枢纽节点。 */
  degree: number;
}

/**
 * 构造一跳扩散的 Cypher。
 *
 * 关键约束都在查询里，不在调用方：
 * - `seed` 之外的节点才算邻居（`NOT m.id IN $seeds`）—— 否则会把已命中的
 *   记忆当成"联想"重复带回。
 * - 同 cube（`m.user_name = $user_name`）—— 跨 cube 串味是 9.6 节的教训。
 * - 排除 `WorkingMemory` 层 —— 与 9.6 节一致，短期副本不该出现在结果里。
 * - 排除 `reasoning` 类型 —— 那是图库自动生成的推断节点（占该 cube 的
 *   3495/6534），不是用户保存的记忆。
 * - 无向匹配（`--`）—— 联想不分方向，只算出边会漏掉一半。
 */
export function buildSpreadCypher(): string {
  const types = SPREAD_EDGE_TYPES.map((t) => `'${t}'`).join(", ");
  return `
    MATCH (n:Memory)-[r]-(m:Memory)
    WHERE n.id IN $seeds
      AND type(r) IN [${types}]
      AND NOT m.id IN $seeds
      AND m.user_name = $user_name
      AND coalesce(m.status, 'activated') = 'activated'
      AND coalesce(m.memory_type, '') <> 'WorkingMemory'
      AND coalesce(m.type, '') <> 'reasoning'
    WITH m, n, type(r) AS via, size([(m)--() | 1]) AS degree
    WITH m, collect({via: via, from: n.id})[0] AS edge, degree
    RETURN m.id AS id, m.memory AS memory, m.key AS key, m.tags AS tags,
           m.updated_at AS updated_at, edge.via AS via, edge.from AS from,
           degree
  `;
}

/**
 * 按优先级与度数排序，截到上界。
 *
 * 排序键依次是：边类型优先级 → 度数升序 → id。
 *
 * **度数升序是刻意的**：低度数邻居更"专属"，信息量更高；高度数节点接近枢纽，
 * 带回来的相关性更弱。前置测量显示 72% 邻居只被单一源共享，所以这一项主要
 * 用于压制那 388 个 31+ 度节点，而不是普遍性的 hub 抑制。
 *
 * id 兜底保证确定性 —— 否则同分邻居的顺序取决于 Neo4j 返回序，测试会闪烁。
 */
export function rankNeighbours(
  neighbours: readonly SpreadNeighbour[],
  limit = SPREAD_LIMIT,
): SpreadNeighbour[] {
  const priority = new Map<string, number>(
    SPREAD_EDGE_TYPES.map((t, i) => [t, i]),
  );
  const rank = (via: string): number =>
    priority.get(via) ?? SPREAD_EDGE_TYPES.length;

  return [...neighbours]
    .sort((a, b) => {
      const byType = rank(a.via) - rank(b.via);
      if (byType !== 0) return byType;
      const byDegree = a.degree - b.degree;
      if (byDegree !== 0) return byDegree;
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * 把邻居转成 MemoryNode，并打上可解释标记。
 *
 * `relativity` 给 0.45：低于直接命中，但高于"完全不相关"。扩散来的记忆
 * 是**旁证**而非答案，排序上不该盖过真正匹配查询的那些。
 * 这个值未经测量校准 —— 与半衰期、阈值同属"有理由但未验证"的一类。
 */
/**
 * 扩散节点 relativity 的地板值。
 *
 * 当候选集里所有直接命中的 relativity 都很低（如 0.15）时，压到它之下会
 * 逼近 0。取 0.05 而非丢弃：联想仍在结果里但排最后，agent 想看能看到。
 */
export const SPREAD_RELATIVITY_FLOOR = 0.05;

/** 压到最低直接命中之下的间距。够小以免过度惩罚，够大以免浮点相等。 */
const SPREAD_MARGIN = 0.01;

/**
 * 算扩散节点该用的 relativity —— **绝不压过任何直接命中**。
 *
 * 维护者决定（2026-08-21，见 [DECISION] a4b3ed39）：「弱匹配也是匹配，
 * 联想不是」。所以不能用固定值 —— 直接命中的 relativity 来自后端，
 * 弱匹配可能只有 0.3，而固定 0.45 会让联想排到它前面。
 *
 * 取候选集里直接命中的**最低** relativity 再减一个间距。没有直接命中时
 * （理论上不会发生，扩散需要种子）退回地板值。
 */
export function spreadRelativity(directHits: readonly MemoryNode[]): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const node of directHits) {
    if (isSpreadNode(node)) continue;
    const raw = Number(
      (node.metadata as Record<string, unknown> | undefined)?.relativity,
    );
    if (Number.isFinite(raw)) lowest = Math.min(lowest, raw);
  }
  if (!Number.isFinite(lowest)) return SPREAD_RELATIVITY_FLOOR;
  return Math.max(SPREAD_RELATIVITY_FLOOR, lowest - SPREAD_MARGIN);
}

/**
 * 把邻居转成 MemoryNode，并打上可解释标记。
 *
 * `relativity` 由调用方经 `spreadRelativity()` 算出 —— 它依赖候选集，
 * 不是模块常量。缺省值只用于单元测试。
 */
export function toSpreadNode(
  n: SpreadNeighbour,
  relativity = SPREAD_RELATIVITY_FLOOR,
): MemoryNode {
  return {
    id: n.id,
    memory: n.memory,
    key: n.key,
    tags: n.tags ?? [],
    updated_at: n.updated_at,
    metadata: {
      relativity,
      status: "activated",
      [SPREAD_VIA_KEY]: n.via,
      [SPREAD_FROM_KEY]: n.from,
    },
  } as MemoryNode;
}

/** 该节点是扩散带回的吗。 */
export function isSpreadNode(node: MemoryNode): boolean {
  const meta = (node.metadata ?? {}) as Record<string, unknown>;
  return (
    typeof meta[SPREAD_VIA_KEY] === "string" && meta[SPREAD_VIA_KEY] !== ""
  );
}

/**
 * 把扩散所得并入既有候选集。
 *
 * 已存在的 id **不覆盖** —— 直接命中的记忆带着真实的 `relativity`，
 * 被扩散节点的 0.45 覆盖会让它掉出应有位置。
 */
export function mergeSpread(
  existing: readonly MemoryNode[],
  spread: readonly MemoryNode[],
): MemoryNode[] {
  // seen 边扩边加：同一个邻居可能从多个种子扩散而来（前置测量显示 28% 的
  // 邻居被 2 个以上源共享），只对 existing 去重会让它重复出现。
  const seen = new Set(existing.map((n) => String(n.id ?? "")));
  const added: MemoryNode[] = [];
  for (const node of spread) {
    const id = String(node.id ?? "");
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    added.push(node);
  }
  return [...existing, ...added];
}

/** 一次扩散最多用多少个已命中记忆当种子。 */
export const SPREAD_SEED_LIMIT = 8;

/**
 * 从候选集里挑种子。
 *
 * 只用**排在最前的**若干条：它们是相关度最高的直接命中，从它们扩散最可能
 * 带回有用的旁证。用全部候选当种子会让邻居集膨胀到无从截断（top_k 20 条
 * × 中位 10 邻居 = 200 量级），且低分命中的邻居本身相关性就弱。
 *
 * 扩散所得**不参与二次扩散** —— 调用方传进来的应当只有直接命中。
 */
export function pickSeeds(
  candidates: readonly MemoryNode[],
  limit = SPREAD_SEED_LIMIT,
): string[] {
  const out: string[] = [];
  for (const node of candidates) {
    if (out.length >= limit) break;
    if (isSpreadNode(node)) continue;
    const id = String(node.id ?? "").trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Neo4j 一行结果 → SpreadNeighbour。字段缺失时返回 null，由调用方过滤。 */
export function rowToNeighbour(
  row: readonly unknown[],
): SpreadNeighbour | null {
  const id = String(row[0] ?? "").trim();
  const via = String(row[5] ?? "").trim();
  const from = String(row[6] ?? "").trim();
  if (id === "" || via === "" || from === "") return null;
  const degree = Number(row[7]);
  return {
    id,
    memory: String(row[1] ?? ""),
    key: row[2] === null || row[2] === undefined ? undefined : String(row[2]),
    tags: Array.isArray(row[3]) ? row[3].map(String) : [],
    updated_at:
      row[4] === null || row[4] === undefined ? undefined : String(row[4]),
    via,
    from,
    degree: Number.isFinite(degree) ? degree : 0,
  };
}
