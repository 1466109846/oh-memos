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

按 `docs/plans/2026-08-18-mcp-sdk-v2-migration-and-evolution.md` 的分期策略实施 SDK 与协议迁移。本轮继续完成 Phase 3 的协议/客户端/部署矩阵，并把可重复的合同接入 CI；不发布 npm、不移动 dist-tag、不合并 base 分支。

## 当前阶段

Phase 0、Phase 1、Phase 2 已提交并推送；Phase 3 自动化矩阵与 3.3 真实 host canary 已完成。Phase 4 的本地 tarball 安装门禁已通过，下一检查点是 registry `next` 发布和观察窗口。

## 工作阶段

- [x] Phase 0.1：在 SDK v1.27.1 上运行 build、154 个 Vitest、schema budget 与 Lite smoke，记录 legacy 基线
- [x] Phase 0.2：先增加 21 个 protocol contract 测试和 raw JSON-RPC stdio smoke，锁定 tools/list、tools/call、Full/Lite 与参数兼容行为
- [x] Phase 0.3：将 `@modelcontextprotocol/sdk` 升到 `^1.30.0`，lockfile 固定 `1.30.0`，并通过同一套门禁
- [x] Phase 0.4：记录验证结果、已知兼容边界与回滚点
- [x] Phase 1：迁移 server v2 / Zod 4 / Node 20，仍用 direct `server.connect(new StdioServerTransport())`
- [x] Phase 2：引入 `serveStdio(buildServer, { legacy: "serve" })` 和受测 transport decorator
- [x] Phase 3.1：补齐协议/客户端/Provider/输入/生命周期矩阵
- [x] Phase 3.2：接入 Node 20/22、schema snapshot、pack dry-run 与 Windows CI
- [x] Phase 3.3：记录真实 host canary 能力与不可用条件
- [x] Phase 4.1：真实 `npm pack`、全新目录安装、安装包 Lite smoke 与 raw RPC save/search/get
- [~] Phase 4.2：**由维护者决定跳过** npm `next` canary 与 7 天观察窗口，直接发布 stable `3.0.0` 到 `latest`
- [x] Phase 5：稳定版文档、兼容承诺与 `3.0.0` 发布

## Phase 4.2/5 发布决策（2026-08-19，维护者指示）

维护者明确选择直接发布 stable `3.0.0` 到 npm `latest`，并同步 Python 版本与 GHCR 镜像 tag，
因此本轮**不执行**原计划的 `3.0.0-next.0` → npm `next` → 7 天观察窗口路径。

| 项目 | 原计划 | 实际执行 |
|---|---|---|
| npm 版本/标签 | `3.0.0-next.0` → `next` | `3.0.0` → `latest` |
| 观察窗口 | 至少 7 天 | 跳过；以已通过的自动化矩阵 + Phase 3.3 host canary + Phase 4.1 tarball 门禁为依据 |
| Python / 镜像 | 不在本阶段 | `pyproject.toml`、`__init__.py` 同步 `3.0.0`，打 `v3.0.0` 触发 GHCR `3.0.0/3.0/3/latest` |
| Agent 配置 | canary 期间不改持久化配置 | 三个 host 改为 `npx -y oh-memos-mcp@3.0.0` |

未被这次决定覆盖的风险，如实记录而不是宣称已消除：

- 没有 registry `next` tarball 安装证据，也没有跨天的真实使用观察；`latest` 一旦移动，Node 18 用户
  的 `npx -y oh-memos-mcp` 会立即失败，缓解手段是文档中已给出的 `oh-memos-mcp@2` 固定方式。
- 三类 host 的真实握手在 Phase 3.3 中均为 legacy 2025-era；modern `2026-07-28` 仅由仓库内 v2
  client/协议矩阵覆盖，不能据此声称 host 已普遍启用 modern wire。
- `docs/CHANGELOG.md` 早期存在与本次发布无关的 `[3.0.0] - 2026-08-02` 旧编号条目，已在新条目中显式说明，
  但历史条目未重新编号。

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

## Phase 1 执行批次

- [x] Phase 1.0：恢复上下文、确认隔离 worktree 清洁，并复验 Phase 0 的 build / 175 tests / schema budget / protocol smoke / Lite smoke
- [x] Phase 1.1：运行官方 codemod dry-run 与正式迁移，升级到 server v2 / Zod 4 / Node 20，并清零旧 SDK import
- [x] Phase 1.2：迁移真实 `tools/list` schema budget 与 semantic contract，保持 17 工具业务约束不变
- [x] Phase 1.3：完成 Node 20 / Node 22、legacy wire、Full/Lite、条件工具和回滚门禁复验

## 错误记录（Phase 1 实施）

| 错误 | 次数 | 处理 |
|---|---:|---|
| Windows Store `python.exe` 运行 `session-catchup.py` 退出码 1 且无输出 | 1 | 改用系统 `py.exe`，脚本成功退出且无未同步上下文 |
| 首次并行 import 审计的 `rg` 正则被 PowerShell 转义截断 | 1 | 改用单引号简化 pattern 后成功完成全仓审计 |
| 聚焦 Vitest 未完整设置仓库 CI fixture，收集阶段先后报 `MEMOS_URL` / `MEMOS_USER` required | 2 | 两次均未进入 schema 断言；读取 CI 后改为一次性设置 `MEMOS_URL`、`MEMOS_USER`、`MEMOS_DEFAULT_CUBE`、`MEMOS_CUBES_DIR` |
| schema-budget 与 hash 的复合 patch 中一个旧哈希锚点抄写错误 | 1 | `apply_patch` 整体拒绝且未写入；拆分为独立小补丁并使用文件中的精确旧值 |
| schema budget 首次使用过长的内部 cube fixture，导致字节数受默认值长度影响 | 1 | 固定预算进程使用 CI 同长 `ci_cube`，重新 freeze 后跨外部 cube 环境检查均为 0.0% 漂移 |

## Phase 1 结果

- `@modelcontextprotocol/server@2.0.0`、Zod 4、Node `>=20.0.0` 已落地；`tsx` 更新到 `4.23.12`，消除开发链 `esbuild` 低危审计项；Vitest 固定为 `3.2.7`。
- `src/server.ts` 保持 direct `server.connect(new StdioServerTransport())`、`2025-11-25` legacy 协议、字符串化 arguments 兼容和 unknown-key 非致命行为；未引入 `serveStdio`、`server/discover` 或 `2026-07-28`。
- 真实 Phase 0/Phase 1 `tools/list` 逐字段审阅通过：17 个工具的名称、顺序、描述、annotations 和业务约束不变；仅接受 JSON Schema dialect、SDK metadata、Zod strip 表达和 safe-integer 边界的预期 wire 差异。
- Node 版本 gate 在动态加载 SDK/config 前拒绝 Node 18，并新增 3 项单测；CI Node 20 job 已加入 `npm run test:protocol`。

## Phase 1 最终门禁

| 检查 | 结果 |
|---|---|
| Node 24.12.0 | build、21 files / 178 tests、schema 0.0%、protocol/Lite smoke 通过 |
| Node 20.19.4 | build、21 files / 178 tests、schema 0.0%、protocol/Lite smoke 通过 |
| Node 22.18.0 | build、21 files / 178 tests、schema 0.0%、protocol/Lite smoke 通过 |
| Node 18.20.8 | 按预期退出码 1，并输出 Node `>=20.0.0` 升级提示 |
| npm audit | production 与完整依赖均 0 vulnerabilities |
| import/marker audit | 无旧 SDK import、codemod marker、`serveStdio` 或 modern-era 标记 |

## Phase 2 结果（已推送）

- `buildServer()` 只构造 server/注册工具；`NormalizingStdioTransport` 在 era classification 和 schema validation 前保留字符串参数兼容与 raw key capture。
- `runServer()` 使用 `serveStdio(buildServer, { legacy: "serve", transport, onerror })`；background init 延迟到第一次真实 `tools/call`，SIGINT/SIGTERM 关闭幂等。
- v2 client legacy/auto/pin、raw legacy、probe/fallback、4.8 MB stdio boundary 和 signal close 已由 `npm run test:protocol` 覆盖。
- Commit `d8081e28e99b18c6c15cf7a4df6d43ed9efb8c42` 已推送到 `origin/docs/mcp-v2-migration-plan`；包版本仍为 `2.1.0`。

## Phase 3 执行批次

- [x] 先写并运行矩阵合同：默认/条件工具、Full/Lite、普通/stringified/unknown/empty/large 输入、probe/fallback/close/signal。
- [x] 实现最小 harness 变化并完成 Green，保留现有 v2 smoke 的兼容行为。
- [x] 更新 CI Node 20/22 matrix、semantic schema snapshot、`npm pack --dry-run` 和 Windows smoke job。
- [x] 运行最终 staged 验证，更新项目记忆，再提交并推送本阶段；真实 host canary 结果已补录，Phase 4 发布门禁仍保留。

## Phase 3 自动化结果

- `npm run test:protocol`：raw legacy + v2 legacy/auto/modern pin，Full/Lite，16/17 tools，普通/stringified/unknown/empty/large 输入，probe/fallback、pipe close、SIGINT/SIGTERM 全部通过。
- `npm test`：24 个 test files / 184 tests；`npm run schema:budget`：17981 B / 0.0% drift；`npm run schema:semantic`：17-tool snapshot 匹配；Lite smoke、`npm audit`、`npm run test:pack` 均通过。
- CI：Ubuntu Node 20/22 matrix；Windows Node 20 protocol/snapshot/pack job。
- host canary：Claude/Codex/Qwen 均在隔离配置中完成真实 initialize、tools/list、Lite 写读和独立进程重连；三者实际协商仍是 legacy 2025-era，modern `2026-07-28` 只由仓库 v2 client 矩阵覆盖。

## Phase 3.3 真实 host canary 结果（2026-08-19）

| Host | initialize | tools/list | 业务调用与重连 | 临时记录 |
|---|---|---:|---|---|
| Claude Code 2.1.220 | `2025-11-25` | 16 | suggest/save/search/get；新进程 search/get 成功 | `16f86199-4bb2-44ee-ba65-9cbe52d2b896` |
| Codex 0.147.0 | `2025-06-18` | 16 | suggest/save/search/get；新进程 search/get 成功 | `3539b73c-8800-4437-8c4d-a4ca005553c2` |
| Qwen 0.21.13 | `2025-11-25` | 16 | 首进程 suggest/save/search，第二进程 search/get 成功 | `b506ae07-a523-40d3-acb5-e37d21ea5e2b` |

证据约束：relay 只记录方向、方法、ID、协议版本、工具名和工具数量，不记录参数、结果或凭据；所有数据写入临时 Lite cube。Codex 的一次隔离 provider 401 和 Qwen 首次墙钟超时均已恢复，不构成服务端协议失败。临时 server 环境必须显式设置 `MEMOS_USER`，否则进程会在 initialize 前退出。

## Phase 3 错误记录

| 错误 | 次数 | 处理 |
|---|---:|---|
| 并行 `npm test` 未传 CI fixture，收集阶段报 `MEMOS_URL is required` | 1 | 按 workflow 补齐四个环境变量后重跑，24 files / 184 tests 通过 |
| Windows `spawnSync npm.cmd` 返回 `EINVAL` | 1 | 改用 `%ComSpec% /d /s /c` 调用 npm，pack dry-run 通过 |
| 全局 `*.json` 忽略规则隐藏 semantic baseline | 1 | `.gitignore` 增加明确例外并确认 checkout 可见 |
| host canary 初始环境缺少 `MEMOS_USER` | 1 | 补充临时用户变量后重跑，三宿主均完成握手和业务闭环 |
| Codex `--ignore-user-config` provider 返回 401 | 1 | 保留登录态，仅覆盖临时 MCP server；后续 canary 全部通过 |
| Qwen 首次 headless 运行超过墙钟预算 | 1 | 保留已完成的 save/search，第二个进程补做 search/get 并通过 |

## Phase 4.1 本地发布包门禁（2026-08-19）

- [x] 重新 build 并生成真实 `oh-memos-mcp-2.1.0.tgz`；检查实际包边界和产物大小。
- [x] 在全新临时目录安装 tarball，核对 version、Node `>=20.0.0` engine、bin 入口、dist 文件和源码未泄漏。
- [x] 从安装后的 `dist/index.js` 运行 Lite smoke，并用独立 raw JSON-RPC 进程完成 initialize、16-tool list、save/search/get 和 JSONL 持久化回读。
- [x] 精确清理临时 pack/install/cube 目录；未发布 npm、未移动 dist-tag、未改动持久化 Host 配置。

### Phase 4 未完成项

- registry `next` tarball 安装和 `npx -y oh-memos-mcp@next` smoke 尚未执行；当前包版本仍为 `2.1.0`。
- 7 天 canary 观察窗口、release notes、Phase 5 文档同步和 stable `3.0.0` 发布均保持 pending。

## Phase 4 错误记录

| 错误 | 次数 | 处理 |
|---|---:|---|
| 首次安装包 Lite smoke 在 install 根目录运行，脚本按 cwd 查找 `dist/index.js` 而超时 | 1 | 改在 `node_modules/oh-memos-mcp` 包目录运行同一脚本；随后所有 Lite 检查通过 |
| PowerShell 临时命令中的脚本路径变量被单引号保留为字面量 | 1 | 改用已解析的绝对路径重跑；未改变包内容 |
