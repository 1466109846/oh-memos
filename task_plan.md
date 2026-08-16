# oh-memos GitHub 展示分析计划

## 目标

基于 `G:\test\oh-memos` 的真实代码与配置，生成适合 GitHub 展示的架构文档和可交互 Archify 图，并把产物直接写入项目目录。

## 当前阶段

历史 GitHub 展示任务与 Graphify 借鉴方案实现均已完成；当前状态：最终复验通过，等待提交/发布安排。

## 阶段

- [x] 阶段 1：确认仓库状态、技术栈、入口与现有文档
- [x] 阶段 2：追踪核心模块、请求/工具调用与数据流
- [x] 阶段 3：编写 `ARCHITECTURE.md` 与 GitHub 展示内容
- [x] 阶段 4：创建并修复 Archify 架构图候选
- [x] 阶段 5：showcase 校验、HTML 交付与视觉检查
- [x] 阶段 6：最终复验、Git 差异审计与交付说明

## 交付物

- `README.md`：英文 GitHub 首页
- `README_CN.md`：与英文版对齐的中文首页
- `ARCHITECTURE.md`：架构、数据流、模块和修改导航
- `docs/architecture/oh-memos.architecture.html`：可交互架构图
- `docs/architecture/oh-memos.architecture.json`：可维护的 Archify 源文件

## 决策

| 决策 | 原因 |
|---|---|
| 所有最终产物写入项目目录 | 用户明确要求直接用于 GitHub 展示 |
| 只记录有代码或配置证据支持的事实 | 避免展示文档与真实实现偏离 |

## 错误记录

| 错误 | 次数 | 处理 |
|---|---:|---|
| `session-catchup.py` 退出码 1 且无错误文本 | 1 | 确认脚本与项目存在；项目尚无计划文件，初始化新会话 |

---

# 2026-08-16 Graphify 借鉴方案实现计划

## 目标

在不替换 oh-memos 现有 Qdrant/Neo4j 记忆架构的前提下，落地 Graphify 最有价值的能力：

1. 统一图谱关系的证据、来源和置信度表达；
2. 让 `memos_graph` 的 related/path/impact 结果可解释、可审计；
3. 为后续 Graphify `graph.json` 导入、代码符号节点和 git 影响分析预留稳定合同；
4. 将优化后的分层架构图同步到 `ARCHITECTURE.md`、`README.md`、`README_CN.md` 和 `docs/CHANGELOG.md`；
5. 用测试和文档漂移检查保护实现，避免架构图与代码再次脱节。

## 范围与非目标

- 本轮先实现 P0，并完成 P1 的可插拔导入边界；不重写 tree-sitter，不把代码符号写入普通长期记忆。
- Graphify 能力复用现有 `memos_graph`，不新增独立工具或改变默认部署拓扑；所有新增字段保持向后兼容。
- 不在没有真实 Graphify 图文件的情况下伪造导入结果；导入器先提供严格校验和 dry-run 能力。

## 阶段

- [x] 阶段 1：基线、数据合同与测试夹具（先写失败测试）
- [x] 阶段 2：provenance 规范化与图谱结果解释增强
- [x] 阶段 3：Graphify `graph.json` 校验/导入适配器（dry-run 优先）
- [x] 阶段 4：架构图、README、CHANGELOG 和漂移检查同步
- [x] 阶段 5：构建、单测、schema budget、文档链接和安全边界复验

## 预期文件

| 区域 | 文件/目录 | 用途 |
|---|---|---|
| MCP | `mcp-server-node/src/graph-provenance.ts` | 纯函数：证据字段归一化、格式化、Graphify 节点 ID |
| MCP | `mcp-server-node/src/handlers/graph.ts` | related/path/impact 输出 provenance 与 explain 段落 |
| MCP | `mcp-server-node/src/graphify-import.ts` | Graphify JSON 合同校验、稳定 ID、dry-run 导入计划 |
| MCP | `mcp-server-node/src/*.test.ts` | 单元测试与边界测试 |
| 文档 | `ARCHITECTURE.md`, `README*.md`, `docs/CHANGELOG.md` | 新的双图层架构图与变更记录 |
| 计划 | `task_plan.md`, `findings.md`, `progress.md` | 持久化计划、发现和验证证据 |

## 验收标准

- provenance 归一化对旧响应无字段时安全降级，不改变现有文本结果的主要语义；
- related/path/impact 至少能显示关系类型、证据种类、来源和置信度（有值时）；
- Graphify 导入器拒绝非法版本、重复节点 ID、越界置信度和危险路径，并对合法夹具生成确定性计划；
- `npm test`、`npm run build`、`npm run schema:budget` 通过；新增测试覆盖正常、空值、非法输入和重复导入；
- README 与 CHANGELOG 中的架构图来自同一套分层模型，链接和 Mermaid 代码围栏有效。

## 错误记录（新任务）

| 错误 | 次数 | 处理 |
|---|---:|---|
| `session-catchup.py` 无输出退出码 1 | 1 | 保留既有计划与进度，手动恢复后续任务上下文；不重复初始化文件 |
| 新增合同测试在实现前找不到模块 | 1 | 预期的 TDD Red 阶段；下一步实现纯函数模块后重跑 |
| Node MCP README 清单缺少受控标记 | 1 | 预期的文档漂移测试 Red 阶段；加入 `mcp-tool-inventory` 标记后定向测试 4/4 通过 |
| `rg` 查询包含不存在的根 `package.json` | 1 | 删除无效路径后重查；仓库内没有现成 Markdown link checker |
| 默认 `git diff --check` 将 Windows CRLF 报为尾随空白 | 1 | 核对 `core.autocrlf=true` 后使用 `core.whitespace=cr-at-eol` 复验，无真实空白错误 |

## 阶段 1-5 结果

- 新增 `graph-provenance.ts`：统一 `EXTRACTED/INFERRED/AMBIGUOUS/UNKNOWN`、分数、来源和稳定代码节点 ID。
- 新增 `graphify-import.ts`：严格解析 Graphify node-link JSON，输出不写库的确定性 dry-run 计划。
- `memos_graph` 的 path/related/impact 已在有数据时显示关系或节点 provenance；旧 Neo4j 属性缺失时降级为 `UNKNOWN`。
- 先写测试后实现：新增 11 个单测，Red→Green 已完成；TypeScript build 已通过。
- `memos_graph(mode="import")` 已接入工具注册与 dispatch；输入上限 5 MB，只返回校验后的确定性计划，绝不写入 Neo4j、Qdrant 或 cube。
- 分层架构图以 `docs/architecture/oh-memos-layered.mmd` 为唯一源，同步嵌入 `README.md`、`README_CN.md`、`ARCHITECTURE.md` 和 `docs/CHANGELOG.md`。
- `mcp-server-node/README.md` 已同步当前 15 个工具 schema，并详细记录 Graphify import、wiki 回导、Canvas 与 Skill 候选边界；子项目 CHANGELOG 已补充本轮能力。
- 文档漂移测试同时校验四份 Mermaid 拓扑与两个工具清单；最终完整测试为 13 files / 118 tests 全通过。

## 最终验证回执

| 检查 | 结果 |
|---|---|
| `npm test` | 13 个测试文件、118 个测试通过 |
| `npm run build` | TypeScript 编译通过 |
| `npm run schema:budget` | 15 tools，16650 B，较基线 +0.0% |
| 文档链接 / 代码围栏 | 4 份展示文档本地链接有效；6 份相关 Markdown 围栏成对 |
| Archify 冻结产物 | JSON/HTML SHA-256 与最终交付回执一致 |
