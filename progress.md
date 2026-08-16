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
