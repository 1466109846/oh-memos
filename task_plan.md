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

---

# 2026-08-18 MCP SDK v2 与协议 2026-07-28 迁移/演进计划

## 目标

基于官方 MCP 规范、TypeScript SDK v2 迁移文档和本仓库真实实现，形成一份可逐阶段执行、验证和回滚的升级计划；本轮只交付计划文档，不修改 MCP 代码、依赖或发布版本。

## 当前阶段

协议调研、仓库映射、迁移/演进计划和文档复验均已完成；等待用户评审并决定是否进入 Phase 0 实施。

## 工作阶段

- [x] 阶段 1：确认官方协议/SDK v2 变化和仓库约束
- [x] 阶段 2：确定迁移策略、兼容边界和版本策略
- [x] 阶段 3：编写 `docs/plans/2026-08-18-mcp-sdk-v2-migration-and-evolution.md`
- [x] 阶段 4：核对文件清单、验收门禁、链接、围栏与 Git 差异
- [x] 阶段 5：完成计划记录并交付用户评审

## 已定原则

| 决策 | 原因 |
|---|---|
| 迁移对象只包含活跃的 `mcp-server-node/` | Python `mcp-server/` 已明确标记 deprecated |
| 先迁 SDK/运行时，再启用新协议 | 降低依赖升级与 wire behavior 同时变化的排障复杂度 |
| 首次启用采用 `legacy: "serve"` 双时代兼容 | 保留旧客户端连接能力，并允许新客户端协商 `2026-07-28` |
| 建议以 `3.0.0-next` 开始 canary | Node 18 → 20 是对现有用户的 breaking change |
| 首轮保持工具名、输入 schema 和文本结果不变 | 把协议迁移与产品合同演进解耦，控制回归面 |

## 错误记录（本任务）

| 错误 | 次数 | 处理 |
|---|---:|---|
| 首次 PowerShell worktree 条件表达式语法无效 | 1 | 拆分为 `$pathExists` / `$branchExists` 两个布尔值后成功创建隔离 worktree |
| 首次 `apply_patch` 使用了不存在的 `findings.md` EOF 锚点 | 1 | 重新读取文件尾部，并使用真实末行作为追加锚点 |
| 并行恢复命令中一个子命令失败导致 `Promise.all` 整体退出 | 1 | 改为逐项 `try/catch`，其余恢复检查均成功完成 |
| `session-catchup.py` 无输出退出码 1 | 1 | 不重复执行；通过 Git 状态、完整计划文件和会话摘要手动恢复上下文 |
| 登录 PowerShell profile 在非交互终端设置光标/预测功能时报错 | 1 | 后续命令使用 `login: false`，不影响仓库内容 |
| 复合 patch 将 Markdown 列表的 `-` 误作删除标记 | 3 | replacement 必须使用 `-- 原列表项`；三次失败均未写入文件，后续避免对列表做 removal，优先使用非列表锚点 |
| SDK migration URL 未加 `.md`，返回超长 VitePress HTML 并被截断 | 1 | 使用页面 `<link rel="alternate" type="text/markdown">` 指向的 `.md` 地址重新读取正文 |
| PowerShell `ConvertFrom-Json` 解析 lockfile 时遇到空字符串属性名 | 1 | 改用 `ConvertFrom-Json -AsHashTable` 或 Node JSON parser 读取结构化版本字段 |
| 推导的 `serveStdio` TypeDoc URL 返回 v1 站点 404 | 1 | 以官方 `v2/serving/stdio.md` 的完整行为说明为准；不重复猜测 API 路径 |
| URL-encode `@` 后 TypeDoc 地址仍返回同一 404 | 1 | 停止尝试该文档路由；如需签名细节改查已发布 npm 包内容 |
| 首轮 Markdown audit 只取 `git diff --name-only`，漏掉 untracked 新计划 | 1 | 合并 tracked diff 与 `git ls-files --others --exclude-standard` 后重跑 |
| 计划结构检查末尾 `rg` pattern 被 PowerShell 引号截断 | 1 | 必需项检查本身已通过；改用 `Select-String -SimpleMatch` 输出证据 |
| 在 JavaScript orchestration 中直接使用 PowerShell here-string 语法 | 1 | JS parser 在调用 shell 前拒绝；改为 JavaScript 字符串数组 `join("\n")` 组装命令 |

## 最终复验（本任务）

| 检查 | 结果 |
|---|---|
| `git diff --check` | 通过 |
| 变更路径范围 | 仅 `task_plan.md`、`findings.md`、`progress.md` 和新计划文档 |
| Markdown | 4 个文件代码围栏、尾随空白、末尾换行和本地链接检查通过 |
| 计划要求 | 必需章节和关键词检查通过；计划正文 434 行 |
| 主工作区保护 | 原有 7 个未跟踪路径保持不变 |

---

# 2026-08-18 MCP SDK v2 迁移实施

## 目标

按 `docs/plans/2026-08-18-mcp-sdk-v2-migration-and-evolution.md` 的分期策略实施 SDK 与协议迁移。当前执行范围是可独立回滚的 Phase 0：更新到 SDK v1.30 并冻结 legacy 行为；不提前修改 Node、Zod、server entry 或协议 era。

## 当前阶段

Phase 0 已完成，等待该检查点审阅后进入 Phase 1（SDK v2 + Node 20 + Zod 4，仍保持 direct-connect legacy wire）。

## 工作阶段

- [x] Phase 0.1：在 SDK v1.27.1 上运行 build、154 个 Vitest、schema budget 与 Lite smoke，记录 legacy 基线
- [x] Phase 0.2：先增加 21 个 protocol contract 测试和 raw JSON-RPC stdio smoke，锁定 tools/list、tools/call、Full/Lite 与参数兼容行为
- [x] Phase 0.3：将 `@modelcontextprotocol/sdk` 升到 `^1.30.0`，lockfile 固定 `1.30.0`，并通过同一套门禁
- [x] Phase 0.4：记录验证结果、已知兼容边界与回滚点
- [ ] Phase 1：迁移 server v2 / Zod 4 / Node 20，仍用 direct `server.connect(new StdioServerTransport())`
- [ ] Phase 2：引入 `serveStdio(buildServer, { legacy: "serve" })` 和受测 transport decorator
- [ ] Phase 3：扩大 protocol/host/OS 矩阵并接入 CI
- [ ] Phase 4-5：next canary、观察窗口、稳定版文档与发布

## Phase 0 结果

- 新增 `mcp-server-node/src/protocol-contract.test.ts`，覆盖 17 个工具顺序、annotations、schema 业务语义，以及已存在 raw-key 审计辅助函数。
- 新增 `mcp-server-node/scripts/protocol-smoke.mjs` 和 `npm run test:protocol`，以 raw JSON-RPC child process 验证 `2025-11-25` initialize、默认 16 工具和 delete-enabled 17 工具、Lite 写读、stringified arguments、unknown-key 非致命、非法参数、Full capability 结果与 API failure 文本。
- 当前 package 仍是 `oh-memos-mcp@2.1.0`、Node `>=18.0.0`、Zod 3；因此本检查点不声称支持 `2026-07-28`。
- 可回滚范围：将 `mcp-server-node/package.json` 和 `package-lock.json` 的 SDK 版本恢复到 v1.27.1；合同测试可保留用于比较。

## 错误记录（Phase 0 实施）

| 错误 | 次数 | 处理 |
|---|---:|---|
| Full search fixture 在 API 不可达前先触发 cube fallback config，并因缺少 `MOS_CHAT_MODEL` 返回 `CUBE_REGISTRATION_FAILED` | 1 | 改用不依赖 cube 注册的 `memos_admin(action="create_user")` 请求，稳定锁定真实 `API_ERROR` 文本 |
| 并行 preflight 中 Windows `rg` 路径 glob 无效 | 1 | 改为对 `src` 使用 `-g '*.test.ts'` |
| 通过 PowerShell stdin 调用 `apply_patch` 被 Windows wrapper 拒绝 | 1 | 改用带绝对路径的 Codex `apply_patch` API；未写入错误 patch |
