/**
 * 分层过滤的**强制机制**：让"新增检索路径漏过滤"无法通过构建。
 *
 * ## 为什么需要结构性强制，而不是继续靠 review
 *
 * 同一个缺陷已复发七次。每次都是新增一条取记忆的路径，忘记过滤掉
 * scheduler 管理的 WorkingMemory 层。`handlers/memory.ts` 的注释记了实测
 * 结论：**切断层级过滤后全部 319 项 vitest 依然全绿** —— 单测对这个缺陷
 * 没有感知能力，因为它测的是"过滤函数正确"，不是"过滤被接上了"。
 *
 * ## 真正的不变量
 *
 * 不是"过滤掉 WorkingMemory"，而是 **不把易失 id 交给 agent**。
 *
 * WorkingMemory 每用户只保留最近 20 条（`manager.py:75`），新检索会淘汰
 * 旧的 —— 实测窗口只有 22 分钟。agent 拿这种 id 去 `memos_get`，后端
 * `text_mem.get` 抛 ValueError，被 `start_api.py:1493` 的全局 handler 映射成
 * **HTTP 400**。这就是用户报的那个 400 的成因。
 *
 * 过滤只是满足该不变量的**一种**方式，而且是有损的那种：
 * `filterEphemeralTier` 那条"全 ephemeral 则原样返回"的保护，本身就承认
 * 丢弃不可接受 —— 但原样返回又恰好泄露易失 id。它在两个 bug 之间换手。
 *
 * 实测 `POST /search` 返回 **100% WorkingMemory**，所以 search 路径上那个
 * 过滤是**恒空转**的。无损的替代是**孪生解析**：按 `key` 换成持久层的同容
 * id（实测 51/51 命中，内容与 created_at 逐字节相同，持久层重复 key = 0）。
 *
 * ## 两种复发形态，必须分别守
 *
 * 1. **压根没接过滤** —— `think.ts` / `graph.ts` 就是这形态。
 * 2. **过滤接了但读不到字段** —— 更隐蔽。`search.ts:84-104` 记录了实例：
 *    temporal Cypher 原先不 RETURN `memory_type`，构造出的 metadata 里没这个
 *    键，`isEphemeralTier()` 永远读到 undefined 判为可见，**四个调用点的过滤
 *    全部空转，且没有任何测试失败**。
 *
 * 所以本模块导出两组判定：`hasTierSignal`（形态 1）与
 * `cypherThreadsMemoryType`（形态 2）。
 *
 * ## fail-closed 是本机制的全部价值
 *
 * 分派表是可枚举的。守卫把清单与实际分派表**逐条比对**：新增一个工具而
 * 没在清单里分类 → 构建失败。"忘记"这个动作本身被挡住，而不是等 review
 * 或等用户实测发现。
 *
 * 已知缺口不藏进豁免名单，而是显式记为 `known-gap` 并冻结集合：静默新增
 * 缺口 → 失败；修好一个 → 必须从集合里删掉。是棘轮，不是地毯。
 *
 * 设计文档：docs/design/memory-retrieval-optimization.md 第 9.6 节
 */

/** 一条分派路由的分类。 */
export type TierClass =
  /** 经过 filterEphemeralTier / prepare* 包装，且信号可静态查到。 */
  | "filtered"
  /**
   * 过滤已接线，但"全 ephemeral 则原样返回"会让它空转。
   * 与 `filtered` 分开是因为修复动作不同：这类要等孪生解析落地。
   */
  | "filtered-noop-risk"
  /** 只回显 agent 自己传进来的 id，不产生新 id。 */
  | "id-passthrough"
  /** 输出里没有任何记忆 id。 */
  | "no-id"
  /** 结构上只可能产出持久层 id（实测确认）。 */
  | "persistent-by-construction"
  /** 确认漏过滤，且已记录原因与修复前提。 */
  | "known-gap";

/** 清单里的一条。 */
export interface RouteContract {
  /** 分派键：工具名，或 `工具名:mode/action`。 */
  readonly route: string;
  /** 实现该路由的 handler 文件（相对 `src/handlers/`）。 */
  readonly file: string;
  readonly tierClass: TierClass;
  /**
   * 分类依据。要求写成可核验的形态（行号、实测数字），
   * 不接受"应该没问题"这类无法反驳的说法。
   */
  readonly evidence: string;
}

/**
 * 能满足不变量的信号形态。
 *
 * 必须接受多种形态而不是只认一个函数名：`wiki-export.ts:324` 用的是内联
 * `String(meta.memory_type ?? "") === "WorkingMemory"`，只认
 * `filterEphemeralTier` 会把它误判成缺口。
 */
const TIER_SIGNALS: readonly RegExp[] = [
  /filterEphemeralTier\s*\(/,
  /isEphemeralTier\s*\(/,
  /prepare(?:List|Resume|Search)Memories\s*\(/,
  /resolvePersistentTwins\s*\(/,
  /memory_type\s*\?\?\s*""\s*\)\s*===\s*"WorkingMemory"/,
  /<>\s*'WorkingMemory'/,
];

/**
 * 该 handler 源码里是否存在可达的层级信号。
 *
 * 只做存在性判断 —— "信号在正确位置"由各 handler 自己的接线测试负责
 * （形态见 `context-resume.test.ts` 的 `describe("handler 接线")`）。
 * 本模块管"一条路由有没有被想过"，粒度不同，不要混。
 */
export function hasTierSignal(source: string): boolean {
  return TIER_SIGNALS.some((re) => re.test(source));
}

/**
 * 抽出 Cypher 里投影记忆节点的 RETURN 子句。
 *
 * 只取真的在投影记忆的（含 `.memory`），避免把 schema/统计类查询的 RETURN
 * 也拉进来判。
 */
export function extractMemoryReturns(source: string): readonly string[] {
  const returns: string[] = [];
  const re =
    /RETURN\b([\s\S]*?)(?=\n\s*(?:ORDER|LIMIT|MATCH|WHERE|UNION|\}|`))/gi;
  for (const m of source.matchAll(re)) {
    const clause = m[1];
    if (/\.memory\b/.test(clause)) returns.push(clause);
  }
  return returns;
}

/**
 * 投影记忆的 Cypher 是否把 `memory_type` 也带出来。
 *
 * 这是形态 2 的守卫。漏了这个字段，下游过滤读到 undefined 判为可见 ——
 * 过滤形同不存在，且没有任何测试会红。
 */
export function cypherThreadsMemoryType(clause: string): boolean {
  return /memory_type/.test(clause);
}

/**
 * 从 `handlers/index.ts` 源码里解析出全部分派路由。
 *
 * 用缩进宽度区分顶层与嵌套 `case`：顶层 4 空格，`memos_graph` /
 * `memos_admin` 内层的 mode/action 是 8 空格。比匹配整个 switch 块稳，
 * 也不需要引 TS AST。
 *
 * 嵌套 case 归属由"最近的顶层 case"决定，产出 `memos_graph:path` 这样的
 * 复合键 —— 每个 mode 各自是一条路由，它们走不同 handler，层级安全性独立。
 *
 * `default:` 也算一条（键为 `工具名:default`），否则 `memos_graph` 的
 * `mode=related`（走 default）会整条漏掉 —— 而它恰好是已确认的缺口之一。
 */
export function parseDispatchRoutes(indexSource: string): readonly string[] {
  const routes: string[] = [];
  let currentTop: string | null = null;
  let nestedSeen = false;

  for (const line of indexSource.split("\n")) {
    // 字符类必须含数字 —— `memos_list_v2` 带版本号后缀。写成 [a-z_]+ 会让这
    // 条路由整个消失在清单外，而它正是有过滤的路径之一：守卫会变成一份
    // 自称完整、实际漏了一条的名单。这是本机制要防的同一类缺陷，
    // 初版就踩了一次。
    const top = /^ {4}case "([a-z0-9_]+)":/.exec(line);
    if (top) {
      // 上一个顶层 case 没有任何嵌套 → 它本身就是一条路由
      if (currentTop && !nestedSeen) routes.push(currentTop);
      currentTop = top[1];
      nestedSeen = false;
      continue;
    }

    const nested = /^ {8}case "([a-z0-9_]+)":/.exec(line);
    if (nested && currentTop) {
      routes.push(`${currentTop}:${nested[1]}`);
      nestedSeen = true;
      continue;
    }

    if (/^ {8}default:/.test(line) && currentTop) {
      routes.push(`${currentTop}:default`);
      nestedSeen = true;
    }
  }

  if (currentTop && !nestedSeen) routes.push(currentTop);
  return routes;
}

/**
 * 全部分派路由的层级契约。
 *
 * 每条的 `evidence` 都来自实测或行号，不是推断。守卫会拿这份清单与
 * `parseDispatchRoutes()` 的结果逐条比对，两边不一致就失败 —— 所以新增
 * 工具时**必须**在这里补一条，否则构建不过。这是整个机制的锚点。
 */
export const ROUTE_CONTRACTS: readonly RouteContract[] = [
  // ---- memory.ts ----
  {
    route: "memos_save",
    file: "memory.ts",
    tierClass: "persistent-by-construction",
    evidence:
      "实测：POST /memories 返回的 id 在 Neo4j 里是 UserMemory（持久层），不是 WorkingMemory。",
  },
  {
    route: "memos_list_v2",
    file: "memory.ts",
    tierClass: "filtered",
    evidence:
      "prepareListMemories 内含 filterEphemeralTier；memory.ts:230/293 输出 id。",
  },
  {
    route: "memos_get",
    file: "memory.ts",
    tierClass: "id-passthrough",
    evidence: "memory.ts:344 只消费 agent 传入的 memory_id，不产出新 id。",
  },

  // ---- search.ts ----
  {
    route: "memos_search",
    file: "search.ts",
    tierClass: "filtered-noop-risk",
    evidence:
      "过滤已接线（search.ts:399/466 输出 id）；但实测 POST /search 返回 100% WorkingMemory，" +
      "filterEphemeralTier 的全-ephemeral 保护使其恒空转 —— 需孪生解析才能真正满足不变量。",
  },
  {
    route: "memos_suggest",
    file: "search.ts",
    tierClass: "no-id",
    evidence: "只返回建议 query 字符串，输出里无记忆 id。",
  },
  {
    route: "memos_context_resume",
    file: "search.ts",
    tierClass: "filtered",
    evidence:
      "prepareResumeMemories + buildTemporalCypher 的 tierFilter 双保险；接线由 context-resume.test.ts 守。",
  },
  {
    route: "memos_think",
    file: "think.ts",
    tierClass: "known-gap",
    evidence:
      "think.ts:214 逐条渲染 `> id:`，无任何层级信号。实测：朴素过滤会把语义召回整段丢掉" +
      "（15 → 5，掉 10 条）—— /search 只贡献 ephemeral，temporal 贡献持久，全-ephemeral 保护不触发。" +
      "修复前提是孪生解析，不是加过滤。",
  },

  // ---- graph.ts ----
  {
    route: "memos_graph:default",
    file: "graph.ts",
    tierClass: "known-gap",
    evidence:
      "mode=related。graph.ts:396 把 search 返回的 id 当 Cypher 种子，无层级信号。" +
      "更严重：实测 172 个 WorkingMemory 节点共 0 条边，该查询恒空，永远静默退化到关键词兜底 —— " +
      "是功能失效，不只是 id 泄露。",
  },
  {
    route: "memos_graph:path",
    file: "graph.ts",
    tierClass: "known-gap",
    evidence: "graph.ts:271-273 按 id 取路径并 RETURN 节点 id，无层级信号。",
  },
  {
    route: "memos_graph:impact",
    file: "graph.ts",
    tierClass: "known-gap",
    evidence: "graph.ts:419-421 RETURN source/target id，无层级信号。",
  },
  {
    route: "memos_graph:schema",
    file: "graph.ts",
    tierClass: "no-id",
    evidence:
      "graph.ts:571 只输出计数与类型分布（memory_types），不含任何记忆 id。",
  },
  {
    route: "memos_graph:import",
    file: "graph.ts",
    tierClass: "no-id",
    evidence: "Graphify 校验为 dry-run，只回报校验结果，不写库也不吐 id。",
  },

  // ---- wiki 往返 ----
  {
    route: "memos_export_wiki",
    file: "wiki-export.ts",
    tierClass: "filtered",
    evidence:
      'wiki-export.ts:324 内联 String(meta.memory_type ?? "") === "WorkingMemory" 过滤；' +
      "id 写入文件而非 agent 输出。",
  },
  {
    route: "memos_import_wiki",
    file: "wiki-import.ts",
    tierClass: "id-passthrough",
    evidence: "wiki-import.ts:271 消费 wiki 页面里已有的 id，不产出新 id。",
  },

  // ---- 本地文件类，不经 API ----
  {
    route: "memos_canvas",
    file: "canvas.ts",
    tierClass: "id-passthrough",
    evidence: "canvas.ts:90 只回显 agent 传入的 `mem:<id>` ref，不检索记忆。",
  },
  {
    route: "memos_distill_skill",
    file: "skill.ts",
    tierClass: "id-passthrough",
    evidence: "skill.ts:12 消费 agent 传入的 memory_ids 作为证据来源。",
  },
  {
    route: "memos_list_skill_candidates",
    file: "skill.ts",
    tierClass: "no-id",
    evidence: "只列 candidate 文件名与状态，不含记忆 id。",
  },
  {
    route: "memos_review_skill_candidate",
    file: "skill.ts",
    tierClass: "no-id",
    evidence: "只改 candidate 的审阅状态，输出不含记忆 id。",
  },
  {
    route: "memos_install_skill_candidate",
    file: "skill.ts",
    tierClass: "no-id",
    evidence: "只写 SKILL.md 并回报路径，输出不含记忆 id。",
  },

  // ---- admin.ts ----
  {
    route: "memos_admin:list_cubes",
    file: "admin.ts",
    tierClass: "no-id",
    evidence: "admin.ts:91 输出的是 cube id，不是记忆 id。",
  },
  {
    route: "memos_admin:register_cube",
    file: "admin.ts",
    tierClass: "no-id",
    evidence:
      "admin.ts:107 handleMemosRegisterCube 全部返回分支只输出 cube id 与注册状态；" +
      "grep 该函数体无 .memory / 记忆 id 投影，不经过记忆读取路径。",
  },
  {
    route: "memos_admin:create_user",
    file: "admin.ts",
    tierClass: "no-id",
    evidence:
      "admin.ts:206 handleMemosCreateUser 只输出 user id 与建号/已存在状态；" +
      "不查询记忆节点，无 id 外泄面。",
  },
  {
    route: "memos_admin:validate_cubes",
    file: "admin.ts",
    tierClass: "no-id",
    evidence:
      "admin.ts:252 handleMemosValidateCubes 输出 config.json 校验/修复行(admin.ts:327 results.join)，" +
      "逐条是 cube 配置项而非记忆，无记忆 id。",
  },
  {
    route: "memos_admin:stats",
    file: "memory.ts",
    tierClass: "no-id",
    evidence: "handleMemosGetStats 只输出各类型计数。",
  },
  {
    route: "memos_admin:capabilities",
    file: "admin.ts",
    tierClass: "no-id",
    evidence: "只输出 Full/Lite 能力矩阵，静态文本。",
  },
  {
    route: "memos_admin:calendar",
    file: "calendar.ts",
    tierClass: "no-id",
    evidence:
      "实测 grep 确认 calendar.ts 不输出任何记忆 id。注意它有另一个独立缺陷：" +
      "calendar.ts:65 读顶层 m.memory_type ?? m.type，但 API 顶层只有 " +
      "['id','memory','metadata','project_name'] —— 两者恒 undefined，类型恒渲染成 NOTE。" +
      "那是业务类型轴的 bug，与本模块的层级轴无关，另行修。",
  },
  {
    route: "memos_admin:default",
    file: "index.ts",
    tierClass: "no-id",
    evidence: "未知 action 的错误分支，只回报可用 action 列表。",
  },

  {
    route: "memos_delete",
    file: "admin.ts",
    tierClass: "id-passthrough",
    evidence: "admin.ts:350-352 消费 agent 传入的 memory_id/memory_ids。",
  },
];

/**
 * 当前已知的缺口，**冻结集合**。
 *
 * 与 `ROUTE_CONTRACTS` 里的 `known-gap` 必须完全一致 —— 守卫双向比对：
 * 静默新增缺口 → 失败；修好一个却忘了从这里删 → 也失败。后者同样重要，
 * 否则集合会永久膨胀成一张无人清理的豁免名单。
 */
export const KNOWN_GAPS: readonly string[] = [
  "memos_think",
  "memos_graph:default",
  "memos_graph:path",
  "memos_graph:impact",
];

/**
 * 形态 2 的基线棘轮：每个文件里"投影了记忆但没带 memory_type"的 RETURN 条数。
 *
 * 为什么要基线而不是一律要求 0：`graph.ts` 那 4 处全部落在 KNOWN_GAPS 已冻结
 * 的三条路由里。若断言恒为 0，套件从第一天起就是红的 —— 一个永远红的守卫等于
 * 没有守卫，下一个人只会把它注释掉。
 *
 * 断言用**严格相等**，不是 `<=`：
 * - 新增一处漏字段的投影 → 数字变大 → 失败，这是要防的复发。
 * - 修好一处 → 数字变小 → 也失败，强制回来把基线调下去。棘轮只能往紧的方向走。
 *
 * 未列入此表的文件，隐含基线为 0：新文件一旦出现这种投影就立刻红。
 */
export const CYPHER_PROJECTION_BASELINE: Readonly<Record<string, number>> = {
  // search.ts 已修完（见 search.ts:84-104 的复发记录），必须保持 0。
  "search.ts": 0,
  // graph.ts:273 path / graph.ts:407,419 default / graph.ts:688 impact
  "graph.ts": 4,
};
