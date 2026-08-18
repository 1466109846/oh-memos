# MCP SDK v2 与协议 2026-07-28 迁移及能力演进计划

> 2026-08-18 · 状态：Phase 3 自动化矩阵已完成；真实 host canary 待人工执行

## 决策摘要

结论是：**oh-memos 需要升级到 TypeScript SDK v2，并支持 MCP 协议 `2026-07-28`；但这不是必须立即中断现有用户的紧急升级。**

推荐路线：

1. 先把当前 SDK v1 从 lockfile 的 `1.27.1` 升到最新维护版 `1.30.0`，冻结 legacy 基线。
2. 再迁移到 `@modelcontextprotocol/server@2.0.0`、Node.js 20+、Zod 4.2，但继续使用 2025-era wire behavior。
3. 单独切换到 `serveStdio(buildServer, { legacy: "serve" })`，同时服务旧 initialize 客户端和 `2026-07-28` 客户端。
4. 以 `oh-memos-mcp@3.0.0-next.0` 发布到 npm `next` dist-tag；通过客户端矩阵后再发布稳定 `3.0.0`。
5. `structuredContent`、output schema、cache hints、MRTR 和 Tasks 不与首次迁移捆绑，作为后续独立演进。

升级优先级建议为 **P1（应排入近期版本，但不需要停服抢修）**。当前 v1 仍可工作，旧客户端也不会马上失效；但 SDK v2 是支持 current 协议、逐请求版本协商和后续扩展的正式路径，继续停留在 v1 会逐渐扩大兼容债务。

## 先澄清“2.0”

这里有三种版本号，不能混用：

| 名称 | 当前值 | 含义 |
|---|---:|---|
| oh-memos npm 包 | `oh-memos-mcp@2.1.0` | 本项目自己的 SemVer |
| MCP TypeScript SDK | v1 `@modelcontextprotocol/sdk` → v2 角色包 | SDK 的 SemVer major |
| MCP 协议 | `2025-11-25` → `2026-07-28` | 官方以 `YYYY-MM-DD` 标识不兼容修订 |

因此，“我们的 MCP 已经是 2.1.0”不代表已经支持所谓“MCP 2.0”。当前包仍依赖 SDK v1，并通过 initialize-era stdio 入口运行。

## `2026-07-28` 相比上一版升级了什么

上一正式修订是 `2025-11-25`。本次不是小幅字段扩展，而是协议状态模型的重构。

| 领域 | 2025-era | `2026-07-28` | 对 oh-memos 的影响 |
|---|---|---|---|
| 初始化 | `initialize` + `notifications/initialized` | 移除 handshake | 必须通过 SDK v2 serving entry 才能支持 |
| 版本协商 | 连接初始化时协商 | 每个请求 `_meta` 携带版本与客户端能力 | 由 `serveStdio` 的 era router 处理 |
| 服务发现 | 无统一入口 | 新增必需 `server/discover` | modern client 可先探测再选择版本 |
| 会话 | HTTP 可使用 protocol session / `Mcp-Session-Id` | 协议层 session 被移除 | 当前 stdio server 没有 MCP session state，迁移成本低 |
| server→client 请求 | Roots、Sampling、Elicitation 等主动请求 | MRTR `input_required` + 重试原请求 | 当前未使用，首轮无需改 handler |
| 结果 | 普通 result | wire 上要求 `resultType` | SDK 内部补齐并剥离，业务 handler 不手写 |
| 通知 | unsolicited list/resource notifications | `subscriptions/listen` opt-in stream | 当前没有动态列表通知，不需首轮实现 |
| Tasks | core experimental task surface | 移出 core，成为官方 extension | 不能把 Tasks 当作升级必选项 |
| 缓存 | 客户端自行决定 | cacheable result 带 `ttlMs` / `cacheScope` | SDK 默认发 `0` / `private`，后续再调优 |
| Schema | 较窄的工具 schema / structured content 约束 | JSON Schema 2020-12，`structuredContent` 可为任意 JSON | 生成的 wire schema 会受控重建 |
| 废弃项 | Roots、Sampling、Logging 可正常采用 | 三者进入 deprecated；HTTP+SSE 继续 deprecated | 本仓库未使用，避免新增即可 |
| 可观测性 | 无统一 trace 约定 | `_meta` 支持 OTel trace context | 可作为后续能力，不阻塞本次升级 |

## 当前仓库基线

### 活跃实现

- 活跃服务：`mcp-server-node/`
- 已停用实现：`mcp-server/`，由 `mcp-server/DEPRECATED.md` 明确禁止继续开发
- 传输：本地 stdio，无 HTTP、OAuth、SSE、Roots、Sampling、MCP Logging
- 工具面：17 个 schema，其中 16 个默认注册，`memos_delete` 由环境变量条件启用
- 存储模式：Full API/Neo4j/Qdrant 与 Lite JSONL；协议升级不迁移任何记忆数据

### 依赖和运行时

| 项目 | 声明 | lockfile / 目标 |
|---|---:|---:|
| npm 包 | `2.1.0` | 下一 major `3.0.0-next` |
| Node.js | `>=18.0.0` | v2 要求 `>=20` |
| SDK | `^1.12.0` | lock `1.27.1`；维护基线 `1.30.0`；目标 server `2.0.0` |
| Zod | `^3.25.0` | lock `3.25.76`；目标 `^4.2.0` |
| CI | Node 20 | 已满足 v2 runtime |

### 已确认的仓库特有风险

1. `src/server.ts` 在 SDK 安装 `transport.onmessage` 后再次包装它，以容忍字符串化的 `params.arguments` 并调用 `recordRawArgKeys`；但 `checkArgContract` 当前没有生产调用点，所以 wire 上的真实行为是“未知键不致命，但不会返回审计警告”。
2. `serveStdio` 接管 transport 后，原来的 post-connect monkey-patch 不能机械照搬。
3. v2 支持 `transport?: Transport`，应改成 transport decorator，在 era classifier 之前统一做 normalization。
4. modern auto negotiation 的 stdio probe 会创建短生命周期 sibling process；server factory 可能在 probe/fallback 中构造两次，必须 cheap 且无副作用。
5. 当前 `backgroundInit()` 会访问 API、注册 cube；不能放进 `buildServer()`，否则 probe 进程会产生无意义副作用。
6. `scripts/schema-budget.mjs` 直接 import v2 已删除的 `toJsonSchemaCompat`，必须手工迁移。
7. Zod 4 会改变 `tools/list` 的 JSON Schema 2020-12 表达；不能把“兼容”定义为字节完全一致。

## 目标与非目标

### 目标

- 同一个 npm 包同时服务 2025-era initialize 客户端和 `2026-07-28` 客户端。
- 保持 17 个工具的名称、业务输入约束、annotations、副作用语义和人类可读文本结果。
- 保持 Full/Lite 数据格式、cube 路由和 HTTP API 合同不变。
- 保留 stringified arguments 容错与 raw argument key 捕获；是否启用已有但未接线的 unknown-key warning 另立兼容决策，不与 SDK 迁移捆绑。
- 提供可自动执行的 legacy/modern protocol contract matrix。
- 发布和回滚不依赖删除 npm 版本，不要求迁移用户数据。

### 非目标

- 首轮不建设 remote Streamable HTTP server。
- 首轮不新增 OAuth、Roots、Sampling、MCP Logging 或 Tasks extension。
- 首轮不把全部文本结果改成 `structuredContent`。
- 首轮不改变工具名、合并工具或新增 workflow tool。
- 不恢复或同步 deprecated Python MCP server。
- 不在 `3.0.0` 首发时启用 `{ legacy: "reject" }`。

## 迁移原则

1. **依赖迁移与 wire protocol 激活分开。** 出错时能判断是 Node/Zod/SDK API 问题，还是 era negotiation 问题。
2. **业务合同先保持稳定。** 迁移版本不同时引入 output schema 或产品功能。
3. **factory 无副作用。** 所有 API/cube 预热延后到第一次真实工具调用，并使用进程级 once guard。
4. **用语义比较 schema。** 字段、required、enum、default、min/max、description 必须等价；dialect 序列化允许受控变化。
5. **默认双时代。** 旧客户端继续工作，新客户端可协商 modern；modern-only 必须另做决策。
6. **先 next，再 latest。** Node 18 → 20 是 breaking change，必须走 major canary。

## Phase 0：建立 SDK v1.30 维护基线

### 目的

把“现有代码本身的问题”和“SDK v2 迁移问题”分开，同时冻结可比较的 legacy 行为。

### 变更

- 将 `@modelcontextprotocol/sdk` 从 lock `1.27.1` 升到 `1.30.0`。
- 暂不改 Node engines、Zod、import 和 server wiring。
- 冻结以下基线产物：
  - 17 个 tool name 的确定性顺序；
  - 每个工具的业务 schema 摘要；
  - annotations；
  - 代表性成功/失败文本结果；
  - initialize、tools/list、tools/call 的 legacy transcript；
  - stringified arguments 与 unknown-key 行为。

### 验收门禁

- `npm run build`
- `npm test`
- `npm run schema:budget`
- 新增 legacy protocol smoke 全绿
- Full/Lite 各至少一个代表性工具调用结果与 2.1.0 基线等价

### 回滚

只回退 SDK/lockfile 到 `1.27.1`。该阶段不应包含其他变更。

### 执行结果（2026-08-18）

- 已将 `@modelcontextprotocol/sdk` 声明更新为 `^1.30.0`，lockfile 精确解析为 `1.30.0`，仍使用 npmmirror 下载地址。
- 新增 `src/protocol-contract.test.ts`：锁定 17 个工具的顺序、annotations、业务 schema 语义以及 raw-key 审计工具函数。
- 新增 `scripts/protocol-smoke.mjs` 与 `npm run test:protocol`：使用 raw JSON-RPC 覆盖 `2025-11-25` initialize、默认 16 工具、条件 17 工具、Lite 写读、字符串化 arguments、未知键非致命、非法参数、Full 成功/失败文本。
- SDK `1.27.1` 与 `1.30.0` 上同一套合同均通过；Phase 0 未修改 Node engines、Zod、server wiring、工具实现或版本号。
- 当前 schema budget 在 CI fixture `MEMOS_DEFAULT_CUBE=ci_cube` 下为 18033 B，较仓库 18043 B 基线低 0.1%；10 B 差异来自 10 个 schema 中环境相关默认 cube 字符串长度，不是 SDK 1.30 语义漂移。

## Phase 1：迁移到 SDK v2，但保持 legacy wire behavior

### 目的

完成 package split、Node 20、Zod 4 和 API 类型迁移，同时仍使用直接 `server.connect(new StdioServerTransport())`。SDK v2 在这条入口上默认只说 2025-era 协议，因此 wire 变化最小。

### 依赖变更

- runtime dependency：`@modelcontextprotocol/server@^2.0.0`
- runtime dependency：`zod@^4.2.0`
- 删除 runtime dependency：`@modelcontextprotocol/sdk`
- 只有代码实际 import raw spec schemas 时才 direct-add `@modelcontextprotocol/core`
- protocol tests 需要时将 `@modelcontextprotocol/client@^2.0.0` 放入 devDependencies
- `engines.node` 改为 `>=20.0.0`

### 实施步骤

1. 在 `mcp-server-node/` 包根运行 codemod dry-run，再运行正式 codemod。
2. 搜索并清零 `@mcp-codemod-error`。
3. 全仓搜索残留的 `@modelcontextprotocol/sdk`，包含 `scripts/`、tests、fixtures 和文档代码片段。
4. 更新 `src/server.ts` import：`McpServer` 来自 server package，`StdioServerTransport` 来自 server stdio subpath。
5. 保留当前 direct connect 和 `tolerateStringArguments()`，不在本阶段引入 `serveStdio`。
6. 修复 Zod 4 类型差异；当前所有 tool schema 已经是 `z.object()`，不得退回 deprecated raw shape。
7. 重写 `schema-budget.mjs`，优先通过真实 legacy `tools/list` 获取 SDK 实际广告内容，再计算 byte budget。
8. 生成新的 JSON Schema 2020-12 snapshot，并人工审阅 semantic diff。
9. 添加明确的 Node <20 启动错误或安装说明，避免用户只看到深层 runtime failure。

### Schema 兼容定义

以下必须不变：

- tool name；
- 属性名与嵌套结构；
- required/optional；
- enum、default、min/max、长度上限；
- 字段 description 的业务含义；
- annotations；
- 条件工具 `memos_delete` 的启用规则。

以下允许变化，但必须 review：

- `$schema` dialect；
- `$defs` / `$ref` 的展开方式；
- `additionalProperties` 的等价表达；
- JSON key 顺序和总 byte 数；
- Zod 4 生成器带来的合法 2020-12 metadata。

### 验收门禁

- Node 20、Node 22 上 build/test 通过。
- 真实 `tools/list` 成功，17 个工具顺序稳定。
- 每个工具至少通过 schema compile；选取读、写、条件工具各一个执行 `tools/call`。
- 业务 semantic snapshot 无未解释变化。
- schema budget 新基线逐工具审阅后才允许 freeze。
- direct-connect server 仍只通过 initialize 路径工作，尚不声称支持 `2026-07-28`。

### 回滚

回退 package/lock/import/schema budget baseline 到 Phase 0。由于尚未改变 wire entry，回滚不涉及用户配置或数据。

## Phase 2：启用 `serveStdio` 双时代协议

### 目的

让同一可执行包同时支持 2025-era 和 `2026-07-28`，并保留 oh-memos 的 transport 兼容行为。

### 代码结构

建议把 `src/server.ts` 拆成四个清晰职责：

1. `buildServer(): McpServer`
   只读取 package info、构造 server、注册工具；cheap、同步、无网络/磁盘写副作用。
2. `NormalizingStdioTransport`
   装饰 v2 `StdioServerTransport`，在消息进入 `serveStdio` 前解析字符串化 arguments，并记录 raw keys。
3. `startBackgroundInitOnce()`
   进程级 once guard；第一次真实 tool call 时 fire-and-forget，不在 `server/discover` probe 时运行。
4. `runServer()`
   创建 decorator transport，调用 `serveStdio(buildServer, { legacy: "serve", transport, onerror })`，注册 SIGINT/SIGTERM clean close。

### 关键行为

- factory 可能因 probe + fallback 构造两次，所有副作用必须在 factory 外。
- normalization 必须发生在 SDK era classification 和 tool schema validation 之前。
- raw key capture 按 request id 保持现有清理/消费语义。
- background init 失败仍只记录 stderr，不阻断 MCP 连接。
- stdout 继续只承载 JSON-RPC；所有日志走现有 logger/stderr。
- 首发显式使用 `legacy: "serve"`；不使用 `reject`。

### 验收门禁

- 2025-era initialize client 可 list/call。
- v2 client default legacy mode 可 list/call。
- v2 client auto mode 通过 `server/discover` 选择 modern 并可 list/call。
- v2 client pin `2026-07-28` 可 list/call。
- modern probe 本身不访问 MemOS API、不注册 cube、不创建 Lite 数据文件。
- probe fallback 时 factory 可构造两次且不会重复副作用。
- stringified arguments 在 legacy 与 modern 两条路径都成功归一化。
- 5 MB Graphify 输入连同 JSON-RPC envelope 不超过 stdio 10 MB buffer，并得到业务层结果而不是 transport close。
- SIGINT/SIGTERM 调用 handle.close，无 unhandled rejection。

### 回滚

保留 SDK v2 依赖，只把入口恢复为 direct `server.connect(StdioServerTransport)`，即可立即退回 legacy-only wire behavior。若问题在 v2 本身，再回退 Phase 1。

### 执行结果（2026-08-18）

- 新增 `buildServer()`、`NormalizingStdioTransport` 和进程级 `startBackgroundInitOnce()`；factory 只构造并注册工具，API/cube 初始化延后到第一次真实 `tools/call`，probe 不触发副作用。
- `runServer()` 已切换为 `serveStdio(buildServer, { legacy: "serve", transport, onerror })`，保留 SIGINT/SIGTERM 幂等关闭；旧的 direct-connect monkey-patch 改为 transport decorator，因此 legacy 与 modern 都在 schema 校验前归一化字符串化 arguments。
- 开发依赖加入 `@modelcontextprotocol/client@2.0.0`，新增 v2 client smoke：legacy、auto (`server/discover`)、pin `2026-07-28`、双路径字符串参数、probe/fallback、4.8 MB stdio 边界和信号关闭。
- `npm run test:protocol`（raw legacy + v2 matrix）、`npm test`（24 个文件/184 tests）、Lite smoke、schema budget（17981 B，0.0% drift）、Node 20/22 build + v2 smoke、生产/完整 `npm audit` 均通过。
- 尚未发布或移动 npm dist-tag；包版本保持 `2.1.0`。Phase 3 负责跨 OS/host 矩阵，Phase 4 再发布 `3.0.0-next`。

## Phase 3：协议/客户端/部署矩阵

### 自动化矩阵

| 维度 | 覆盖项 |
|---|---|
| Node | 20 LTS、22 LTS |
| OS | Ubuntu、Windows；WSL 至少做 release smoke |
| Era | raw legacy initialize、v2 legacy、v2 auto、v2 modern pin |
| Provider | Full 配置、`MEMOS_PROVIDER=local` Lite |
| 工具面 | 16 默认 + 条件 `memos_delete` |
| 输入 | 正常 object、stringified object、未知 key、空 object、接近大小上限 |
| 生命周期 | discover probe、fallback、正常 close、client pipe close、SIGINT |

### 代表性契约

- `tools/list`：17 名称、顺序、annotations、业务 schema 摘要。
- read-only：`memos_search` 或 `memos_admin(action="capabilities")`。
- mutation：Lite 临时目录中的 `memos_save`，随后 `memos_get` 验证。
- conditional：`MEMOS_ENABLE_DELETE=false/true` 下的工具列表差异。
- error：API 不可达、unsupported Lite operation、未知工具、非法参数。
- compatibility：字符串 arguments 与 unknown-key 报告在两个 era 中相同。

### 真实客户端 canary

至少验证仓库明确支持的三类 host：

- Claude Code 当前稳定版；
- Codex 当前稳定版；
- Qwen 当前稳定版。

每个 host 都执行：启动、list tools、一次只读调用、一次 Lite 写读闭环、重连。记录实际协商 era；旧 host 走 legacy 是成功，不应被当成失败。

### CI 变更

在现有 Node 20 job 之外或其 matrix 中增加：

- Node 20/22；
- `npm run test:protocol`；
- semantic schema snapshot；
- `npm pack --dry-run`，确认 dev-only client harness 不进入发布包；
- Windows protocol smoke（至少 release 分支必须跑）。

### 执行结果（2026-08-18）

- `protocol-v2-smoke.mjs` 现覆盖 Full/Lite、16/17 工具面、legacy/auto/modern pin、普通与字符串化 arguments、unknown key、空对象、4.8 MB stdio boundary、probe/fallback、client pipe close、SIGINT/SIGTERM。
- 新增 `schema-semantic-snapshot.mjs` 与 `schema-semantic-baseline.json`：冻结 17 个工具的顺序、16 个 always-on/`memos_delete` 条件集合、描述、annotations 和业务 schema hash；忽略 JSON Schema dialect/ref 布局。
- 新增 `pack-contract.mjs` 与 `npm run test:pack`：在 `npm pack --dry-run --json` 上确认 94 个发布文件，开发 client、scripts、源码和测试不会进入 tarball。
- CI Node job 已改为 Node 20/22 matrix，并新增 semantic snapshot、pack contract；Windows Node 20 job 执行 build、protocol smoke、snapshot 和 pack contract。
- 本地证据：`npm run test:protocol`、`npm test`（24 files/184 tests）、`npm run schema:budget`（17981 B/0.0%）、`npm run schema:semantic`、Lite smoke、`npm audit` 和 pack contract 均通过。
- 当前机器检测到 Claude Code 2.1.220、Codex 0.147.0、Qwen 0.21.13；三者已有 `oh-memos` 注册并能在各自的 `mcp list` 健康检查中连接主工作区服务。未把迁移 worktree 注入真实 host，也未发起模型 API 调用或写入 host 配置，因此 Phase 3.3 仍是发布前人工门禁。

## Phase 4：`3.0.0-next` canary 发布

### 发布方式

- 版本：`3.0.0-next.0`，后续修复递增 `.1`、`.2`。
- 命令目标：npm `next` dist-tag，不移动 `latest`。
- 从 registry 安装到全新临时目录，用 `npx -y oh-memos-mcp@next` 做 smoke，不能只测工作区 build。
- release notes 置顶三件事：Node 20 minimum、双时代支持、无数据迁移。

### Canary 退出条件

同时满足以下条件才进入 stable：

- 自动化矩阵全部通过；
- 三类真实 host 均完成至少一次重连后的 list/call；
- Full 和 Lite 均无 P0/P1 回归；
- stringified arguments 兼容路径有真实 transcript；
- 至少 7 天观察窗口，期间没有无法通过退回 legacy era 规避的问题；
- npm tarball 的 engines、依赖、bin、files 清单正确。

### Canary 回滚

- 不删除已发布版本。
- npm `latest` 保持在 `2.1.x`。
- 遇到 modern-only 问题：先发布 next patch，临时恢复 direct connect 或关闭 modern entry。
- 遇到 SDK/Zod/runtime 问题：建议用户固定 `oh-memos-mcp@2.1.0`，并回退到 Phase 0 分支修复。
- 记忆数据、cube 和 Lite JSONL 无格式变化，无需数据回滚。

## Phase 5：稳定 `3.0.0`

### 发布前门禁

- 所有 canary 条件满足。
- 根 README、中文 README、MCP README、部署模式与 MCP 指南全部从 Node 18 更新为 Node 20。
- `mcp-server-node/CHANGELOG.md` 以 Breaking / Added / Migration / Rollback 结构记录。
- 根 `docs/CHANGELOG.md` 同步 major 版本和兼容策略。
- npm `2.x` 维护策略明确。推荐：稳定 3.0.0 后保留 60 天 critical-fix-only 窗口，再标记 EOL；最终期限由维护者确认。
- 安装文档同时给出 `@latest` 与需要 Node 18 时固定 `@2` 的示例。

### 稳定版兼容承诺

| 组合 | 支持状态 |
|---|---|
| `oh-memos-mcp@2.x` + Node 18/20 + 2025-era client | 保持现状，维护窗口内仅 critical fixes |
| `oh-memos-mcp@3.x` + Node 20/22 + 2025-era client | 支持，`legacy: "serve"` |
| `oh-memos-mcp@3.x` + Node 20/22 + `2026-07-28` client | 支持 |
| `oh-memos-mcp@3.x` + Node 18 | 不支持，启动/安装应给出明确提示 |
| `oh-memos-mcp@3.x` + Full/Lite 既有数据 | 支持，无迁移 |
| `oh-memos-mcp@3.x` modern-only | 暂不承诺 |

## 后续能力演进

协议升级稳定后再按独立小版本演进，每项都必须保持文本结果兼容。

### E1：确定性列表与 cache hints

- 用测试锁定 17 个工具的确定性顺序，提高 host prompt cache 命中率。
- 先测量，再为稳定的 list/read result 设置非零 `ttlMs`。
- 默认保持 `cacheScope: "private"`；涉及用户记忆的数据不得改为 public。
- listChanged 能力只在确有动态工具/资源列表时启用。

### E2：annotations 审计

- 逐工具复核 `readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`。
- 对 `memos_delete`、wiki import、skill install 等高风险动作补契约测试。
- annotations 只作提示，不能替代服务端授权和安全检查。

### E3：output schema 与 `structuredContent`

- 从低风险只读工具开始：`memos_admin(capabilities/stats)`、`memos_get`、`memos_list_v2`、`memos_search`。
- 同时返回原有 text content 和新的 structured content，避免旧 host/人类可读体验回归。
- 每个工具独立定义 output schema、正常/空/错误 fixture 和跨 era codec test。
- 不一次性改完 17 个工具；先 2 到 4 个工具验证 client 生态。

### E4：MRTR / `input_required`

只在确有“工具执行中需要用户补充信息”的工作流时采用。当前工具均可通过显式参数完成，不应为了使用新协议而制造交互轮次。

若采用：

- 用 `inputRequired(...)` 写一次 handler，依赖 SDK legacy shim 服务旧客户端；
- `requestState` 必须 HMAC/AEAD、绑定 principal/method/params、带过期时间；
- 设置 round cap、timeout、decline/cancel 测试；
- 不把 Roots/Sampling/Logging 的 deprecated API 重新引入。

### E5：Tasks extension

Tasks 已从 core 移到 `io.modelcontextprotocol/tasks` 官方扩展。只有当目标 host 对该扩展支持成熟，并且 oh-memos 出现真正长时间、可恢复、可轮询的任务时再评估。它不是 SDK v2 或协议 `2026-07-28` 的验收条件。

### E6：Remote Streamable HTTP（独立项目）

若未来需要远程多客户端服务，另立设计：`createMcpHandler`、OAuth、issuer binding、Origin/Host/DNS rebinding 防护、rate limit、审计和部署拓扑。不要把它混入本地 stdio major 升级。

## 预计文件变更清单

| 阶段 | 文件 | 变更 |
|---|---|---|
| Phase 0 | `mcp-server-node/package.json`, `package-lock.json` | SDK v1.30 maintenance baseline |
| Phase 0/3 | `mcp-server-node/scripts/protocol-smoke.mjs`（新） | legacy/modern child-process contract harness |
| Phase 0/3 | `mcp-server-node/src/protocol-contract.test.ts`（新） | tool surface、schema semantic snapshot、代表性 call |
| Phase 1 | `mcp-server-node/package.json`, `package-lock.json` | server v2、client dev harness、Zod 4.2、Node 20 |
| Phase 1 | `mcp-server-node/src/server.ts` | v2 imports，暂保 direct connect |
| Phase 1 | `mcp-server-node/src/tools-registry.ts` | 仅修复 Zod 4 类型/语义差异，不改产品合同 |
| Phase 1 | `mcp-server-node/scripts/schema-budget.mjs` | 移除 v1 converter，改用真实 tools/list |
| Phase 1 | `mcp-server-node/schema-baseline.json` | 经审阅的 2020-12 rebaseline |
| Phase 2 | `mcp-server-node/src/server.ts` | `buildServer`、`serveStdio`、once init、clean close |
| Phase 2 | `mcp-server-node/src/stdio-compat-transport.ts`（新） | string args normalization + raw key capture decorator |
| Phase 2 | `mcp-server-node/src/stdio-compat-transport.test.ts`（新） | legacy/modern/probe 前置 normalization |
| Phase 3 | `mcp-server-node/package.json` | `test:protocol` / pack smoke scripts |
| Phase 3 | `.github/workflows/ci.yml` | Node 20/22、protocol、Windows release gate |
| Phase 4/5 | `mcp-server-node/CHANGELOG.md`, `docs/CHANGELOG.md` | major、canary、rollback 说明 |
| Phase 5 | `README.md`, `README_CN.md` | Node 20 badge、prerequisite、2.x pin |
| Phase 5 | `mcp-server-node/README.md` | SDK/protocol/compatibility/migration |
| Phase 5 | `docs/DEPLOYMENT_MODES.md`, `docs/MCP_GUIDE.md` | Lite/Full runtime 与 client compatibility |

`mcp-server/`、Python API、Neo4j/Qdrant schema 和 Lite JSONL 格式不在变更清单内。

## 总体验收标准

- SDK v2 与协议 `2026-07-28` 被分别验证，不以 package version 猜测协议能力。
- 旧 initialize client 与 modern client 使用同一 npm 包均可 list/call。
- 17 个工具业务合同无未解释变化。
- stringified arguments、unknown key capture、Full/Lite、conditional delete 均有双时代测试。
- server factory 构造可重复、无副作用；probe 不访问后端。
- Node 20/22、Ubuntu/Windows 关键矩阵通过。
- `npm pack` 产物从 registry 安装后通过 smoke。
- canary 期间 `latest` 保持 2.x，回滚只需版本固定或恢复 legacy entry。
- 首次 major 不引入 structured outputs、MRTR、Tasks 或 remote HTTP。

## 官方依据

- MCP `2026-07-28` changelog：<https://modelcontextprotocol.io/specification/2026-07-28/changelog>
- 协议版本与协商：<https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning>
- TypeScript SDK v1 → v2：<https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2>
- 支持协议 `2026-07-28`：<https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28>
- stdio serving：<https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio>
- legacy clients：<https://ts.sdk.modelcontextprotocol.io/v2/serving/legacy-clients>

## 执行顺序

建议按 5 个独立 PR/检查点执行：

1. `chore(mcp): baseline sdk v1.30 protocol contracts`
2. `feat(mcp)!: migrate runtime to sdk v2 and node 20`
3. `feat(mcp): serve legacy and 2026 protocol eras over stdio`
4. `test(mcp): add protocol and host compatibility matrix`
5. `docs(mcp)!: publish 3.0 migration and rollback guide`

每个检查点都必须能单独回滚；Phase 2 之前不得宣称支持 `2026-07-28`，Phase 4 之前不得移动 npm `latest`。
