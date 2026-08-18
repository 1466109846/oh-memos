# oh-memos 分析进度

## 2026-08-15

- 已确认项目目录存在。
- 项目中原先没有 `task_plan.md`、`findings.md`、`progress.md`。
- 已初始化本次 GitHub 展示分析会话。
- 已完成代码入口、Node MCP、FastAPI、MOSCore、Qdrant/Neo4j 和 Docker 部署边界分析。
- 已生成并验证 `ARCHITECTURE.md` 与 Archify HTML/JSON 架构图。
- 已重写 `README.md` 和 `README_CN.md`，统一中英文信息架构并压缩重复内容。
- 已修正 Apache-2.0 许可证、Qdrant 宿主端口、MCP 必填配置和安全边界说明。
- 已验证 README 相对链接全部存在，代码围栏配对，无残留占位符。
- 已解除两个架构产物的 Git 忽略，确保可随仓库提交。

## 2026-08-16 Graphify 借鉴方案

- 已读取 planning-with-files、project-memory、tdd-workflow 和 verification-before-completion 工作流约束。
- 已通过 MemOS MCP 恢复 `oh_memos_cube` 上下文，并检索 Docker 双侧写入边界、MCP 工具和文档约定相关记忆。
- 已确认工作区存在前序未提交改动；本任务不回滚、不覆盖无关改动。
- 已建立本轮阶段计划：先做 provenance/解释合同和 Graphify JSON dry-run 边界，再同步架构图文档。
- 已先写 `graph-provenance.test.ts` 与 `graphify-import.test.ts`；Red 阶段按预期因实现模块尚不存在而失败，失败证据已记录。
- 已完成 provenance 纯函数、稳定代码节点 ID 和 Graphify node-link dry-run 计划实现。
- 已增强 `mcp-server-node/src/handlers/graph.ts` 的 path/related/impact 输出，旧数据无 provenance 时显示 `UNKNOWN` 而不虚构来源。
- Green 验证：新增合同测试 11/11 通过；`npm run build` 通过。
- 已补齐 `mcp-server-node/README.md` 的 15 个工具 schema、五种 `memos_graph` 模式、wiki 回导、Skill 候选和 canvas 说明。
- 已在 `mcp-server-node/CHANGELOG.md` Unreleased 记录 provenance 合同与 Graphify node-link dry-run 导入边界。
- 新增 Node MCP README 工具清单漂移断言：首次因缺少清单标记按预期 1/4 失败；加入标记后定向测试 4/4 通过。
- 最终完整验证：`npm test` 13 files / 118 tests 通过，`npm run build` 通过，`npm run schema:budget` 为 15 tools / 16650 B / +0.0%。
- 文档审计：4 份展示文档本地链接有效，6 份相关 Markdown 代码围栏成对，四份架构拓扑由测试确认与 canonical Mermaid 一致。
- Archify 冻结产物复核：JSON/HTML SHA-256 分别为 `ae069b...ddba2` 与 `73b600...ed76`，与视觉验收回执一致。
- 聚焦差异审计已完成；保留工作区中大量无关并行改动，未执行 reset/clean/revert，也未修改冻结的 Archify JSON。

## 2026-08-18 MCP SDK v2 / 协议升级规划

- 已核对官方 MCP `2026-07-28` changelog、协议版本协商规则和 TypeScript SDK v2 升级/兼容指南。
- 已审查活跃 Node MCP 的依赖、启动入口、工具注册、schema budget 脚本、测试与 deprecated Python 边界。
- 已执行官方 codemod dry-run；没有写入代码，保留了需手工处理的迁移提示。
- 已选择高风险迁移所需的隔离工作方式：分支 `docs/mcp-v2-migration-plan`，worktree 位于用户级全局目录；主工作区中的未跟踪文件保持原样。
- 已确定双阶段技术路线：SDK/运行时迁移与协议激活分开，首发采用 legacy + modern 双时代兼容。
- 本轮范围固定为迁移/演进计划文档；未修改 MCP 实现、依赖、lockfile 或版本号。
- 已按仓库规则确认 `oh_memos_cube` 为 loaded，并通过 `memos_context_resume(project_path="G:\\test\\oh-memos")` 恢复近 24 小时上下文；未写入新记忆。
- 已定向检索 SDK v2 / 新协议历史决策；未发现既有迁移方案，后续计划以官方规范和当前代码基线为准。
- 已读取 MCP server 设计最佳实践、本地 TypeScript 指南和仓库既有演进计划格式；识别出本地 TypeScript 指南仍是 v1 示例并在计划中降权处理。
- 已再次从官方站点读取完整 `2026-07-28` changelog 与 versioning 文档，确认新旧协议的重大 breaking changes 和逐请求版本协商机制。
- 首次读取 SDK migration 页面得到 HTML 外壳；已从页面元数据确认官方 `.md` alternate，下一步改取 Markdown 原文。
- 已读取 SDK v2 migration Markdown，确认依赖迁移与新协议启用是两个独立开关；计划将保持这一官方顺序并采用双时代 canary。
- 已继续分块读取 v1→v2 手册，补充 SDK dist layout、stdio buffer 与低层 API 风险；完整官方文档仍在按分块读取到 EOF。
- 已读完 v1→v2 手册第 1-900 行，确认 Standard Schema / Zod 4.2 与真实 `tools/list` 验证是本仓库的核心迁移门禁。
- 已读完 v1→v2 手册第 901-1350 行；错误/Auth 变化与当前 stdio server 基本不相交，schema package routing 仍需按实际 import 决定。
- 已读完 v1→v2 手册至 EOF；已将工具合同门禁从“wire schema 字节不变”修正为“业务约束语义不变 + JSON Schema 2020-12 snapshot 受控重建”。
- 已读完 `support-2026-07-28` 前半，确认 `serveStdio(factory)`、connection-pinned 双时代和无 session state 的迁移路径。
- 已读完 `support-2026-07-28` 至 EOF；确认 cache fields、server identity、resultType 与 subscriptions 均由 SDK serving layer 处理，首轮 handler 改动可保持很小。
- 已回到仓库核对 package 与 server entry；识别出 `buildServer` 抽取、transport normalization hook 和非阻塞 background init 是实施计划的三个代码关键点。
- 已确认 lockfile 精确版本、所有工具均为 `z.object`、schema budget 使用 v2 已移除 helper，且仓库缺少 protocol-era server contract tests。
- 已核验 public npm 与 npmmirror：server v2.0.0 和 SDK v1.30.0 均可用，当前国内镜像无同步阻塞。
- 已完成 Node 版本承诺和发布文档审计；CI 已在 Node 20，外部兼容性与文档同步是 3.0.0 的主要发布风险。
- 已核对官方 stdio serving 生命周期；确定 background init 应改为首次工具调用触发，避免 modern auto probe 产生后端副作用，并补 graceful shutdown。
- 已确认 stdio `legacy:'serve'` 是官方默认；TypeDoc 路由连续两次 404，后续不再尝试该路径。
- 已从 npm 发布包源码确认 custom transport seam；确定以 transport decorator 保留 stringified-arguments/raw-key 行为，并保持 server factory 无副作用。
- 已核对 CI、tsconfig 与 schema baseline；当前基线为 17 tools / 18043 B，CI 已是 Node 20，并已修正早期 15-tool 记忆造成的计划口径偏差。
- 已创建 `docs/plans/2026-08-18-mcp-sdk-v2-migration-and-evolution.md`，包含协议差异、是否升级结论、Phase 0-5、后续 E1-E6、文件清单、兼容矩阵、门禁与回滚。
- 首轮 Git audit 与 base workspace preservation 通过；Markdown/结构检查脚本有 untracked scope 和 PowerShell quoting 两个问题，已记录并准备修正后重跑。
- 第二轮复验命令在 orchestration 层误用了 PowerShell here-string，尚未执行任何 shell 检查；已改用 JS 字符串数组重组命令。
- 最终文档复验通过：`git diff --check`、4 文件 Markdown 检查、计划必需章节/关键词、scoped path 和主工作区保护均通过；未运行代码测试，因为本轮没有修改实现、依赖或配置。

## 2026-08-18 MCP SDK v2 迁移实施 — Phase 0

- 已复用分支 `docs/mcp-v2-migration-plan` 和用户级隔离 worktree；主工作区原有 7 个未跟踪路径保持不变。
- Phase 0 修改范围固定为 SDK v1 维护升级和 legacy 合同测试，没有改 Node engines、Zod、server wiring、工具实现、npm 包版本或发布状态。
- 升级前基线：`npm run build` 通过；19 files / 154 tests 通过；schema budget 17 tools / 18033 B（CI cube fixture）；现有 Lite smoke 通过。
- 先在 SDK `1.27.1` 上新增并运行 `src/protocol-contract.test.ts`：1 file / 21 tests 通过。
- 先在 SDK `1.27.1` 上新增并运行 `scripts/protocol-smoke.mjs`：Lite、Full、delete-enabled 三组 raw JSON-RPC legacy smoke 全部通过。
- 将 `@modelcontextprotocol/sdk` 从声明 `^1.12.0` / lock `1.27.1` 更新为声明 `^1.30.0` / lock `1.30.0`；npmmirror 已提供目标 tarball。
- 升级后完整验证：`npm run build` 通过；20 files / 175 tests 通过；schema budget 17 tools / 18033 B、较冻结值 -0.1%；protocol smoke 通过；Lite smoke 通过。
- 发现并记录：`recordRawArgKeys` 已接 transport，但 `checkArgContract` 无生产调用点；当前 unknown-key wire 行为是非致命且无警告，不在 Phase 0 改变。
- 当前检查点未 commit、未 push、未发布，也未移动 npm dist-tag。
