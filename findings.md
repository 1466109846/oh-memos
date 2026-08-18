# 反查记录 — 2026-08-16（Lite 语义检索轮）

## 数据事故与恢复

本轮全量验证时发现文档守卫测试失败，根因是上一轮的
`perl -pi -e 's/\s+$//'`：`-p` 模式下 `\s` 匹配行终止符本身，把
`docs/CHANGELOG.md` 和 `docs/future/ROADMAP.md` 的全部换行剥掉，两文件压成单行。

恢复方式：`git show :<path>` 取回完好的暂存区版本，ARCHITECTURE.md 的
标记图块（受守卫测试保护）作为规范副本重建 CHANGELOG 的 🧭 章节，
其余 7 个 Unreleased 章节按对话中的原文重新写入；ROADMAP 状态表整块重写。
教训：行尾清理必须用 `s/[ \t]+$//`，绝不能用 `\s+$` 配合 `perl -pi`。

## 目标状态（本轮后）

- ✅ Lite 本地语义检索：可选 Ollama `/api/embeddings`，混合排序
  0.6 语义 + 0.4 词法，embedding 持久化于 JSONL 但永不外泄，
  Ollama 不可用自动回退纯词法（零配置默认不变）。
- ✅ 关系边回灌（上一轮）：`POST /product/graph/relation` + wiki-relations。
- ⏸ tree_text 原地更新：唯一保留项，需跨 Neo4j/Qdrant 的
  ID-preserving saga 与补偿合同，不做 delete+add 伪更新。

## 验证

- Node 测试 19 文件 / 153+ 测试（含 lite-embedding 3 个、provider 语义 5 个）。
- schema budget 0% 漂移；Python 编译通过。
- 文档守卫（architecture-docs.test.ts）恢复绿色。

---

# MCP SDK v2 / 协议 2026-07-28 调研发现 — 2026-08-18

## 协议与版本语义

- MCP 官方协议版本使用日期标识，不使用 SemVer；当前目标规范为 `2026-07-28`。
- 社区口语中的“MCP 2.0”通常指 TypeScript SDK v2 或新一代协议能力，不等于仓库 npm 包 `oh-memos-mcp@2.1.0`。
- TypeScript SDK v2 拆分为 `@modelcontextprotocol/server` 等角色包；仅更换依赖不会自动启用 `2026-07-28`，stdio server 需要改用 `serveStdio(buildServer)` 等 v2 启动方式。
- SDK v2 基线要求 Node.js `>=20`、Zod `>=4.2`；本仓库当前声明 Node `>=18`、Zod `^3.25`，属于公开兼容性破坏。

## 仓库基线

- 活跃服务位于 `mcp-server-node/`；`mcp-server/DEPRECATED.md` 表明 Python 服务不再是迁移目标。
- `mcp-server-node/package.json` 声明 `@modelcontextprotocol/sdk: ^1.12.0`，锁文件当前解析为 `1.27.1`。
- `src/server.ts` 直接创建 `StdioServerTransport` 并调用 `server.connect()`，仍处在 legacy 启动路径。
- `src/server.ts` 还包装了 transport message handler，用于兼容字符串化 `arguments` 并捕获未知键；切换 `serveStdio` 时必须保留并覆盖双协议时代测试。
- 未发现 Roots、Sampling、Logging 或 HTTP+SSE 等需要额外迁移的旧 handler，迁移范围主要集中在依赖、stdio 启动、schema 兼容和测试。

## 推荐方向

- 先建立 SDK v1 最新维护基线，再迁到 v2 角色包但保留 legacy wire behavior；随后单独启用 `serveStdio(..., { legacy: "serve" })` 双时代服务。
- 首次发布建议 `3.0.0-next` canary；验证旧/新客户端矩阵后再发稳定 `3.0.0`，而不是直接 modern-only。
- 第一轮不改变当前 17 个工具的名称、输入 schema 业务约束、文本结果和副作用语义；`outputSchema` / `structuredContent`、cache hints、更丰富 annotations、MRTR 与 Tasks 放在后续独立演进阶段。
- 官方 codemod dry-run 未直接改文件，提示手工迁移 monolithic SDK、Zod 范围、`scripts/schema-budget.mjs`，并逐项确认工具 schema 为 Standard Schema 对象。
- 项目记忆确认 `oh-memos-mcp@2.1.0` 已于 2026-08-16 发布；这进一步说明 npm 包 SemVer 与 MCP 日期协议版本必须在文档中分开表述。
- 项目记忆中未检索到既有 SDK v2 / `2026-07-28` 迁移决策；现有相关记录主要覆盖 2.1.0 发布、当时的 15-tool 合同与 Lite/Full 部署，因此本计划不需要兼容一份未落库的旧升级方案。
- 本地 `mcp-builder` TypeScript 参考仍展示 SDK v1 monolithic import、Node 18 与 Zod 3 示例，不能作为 v2 依赖/启动方式的权威依据；计划中的版本事实以官方 2026-07-28 规范和 SDK v2 migration pages 为准。
- 仓库现有 `docs/plans` 风格偏向“背景 → 分期 → 设计/安全 → 落地文件 → 遗留项”；新计划沿用该可审阅结构，并额外补充兼容矩阵、验收门禁和逐阶段回滚。
- 官方 changelog 明确 `2026-07-28` 相比 `2025-11-25` 的核心变化：移除 protocol-level session 与 initialize handshake；每个请求通过 `_meta` 携带版本/客户端能力；新增强制 `server/discover`；订阅统一为 `subscriptions/listen`；MRTR 取代 server-initiated requests；所有结果新增必需 `resultType`；Tasks 移出 core 成为扩展；Streamable HTTP 不再支持 SSE 断点续传。
- 与本仓库更直接相关的轻量变化包括：list/read 结果必须带 `ttlMs` 和 `cacheScope`；tools 应稳定排序；JSON Schema 放宽到 2020-12；支持 OpenTelemetry trace context；Roots/Sampling/Logging 被标记 deprecated。
- `2026-07-28` 是 current 协议；协议继续以 `YYYY-MM-DD` 标识不兼容修订。新版按“每个请求”协商，客户端与服务端可以同时支持多个版本，并通过 `UnsupportedProtocolVersionError` / `server/discover` 选择共同版本。
- SDK v2 官方迁移前提是 Node 20+；monolithic `@modelcontextprotocol/sdk` 拆为 server/client/core/adapter 角色包，并依赖 Zod `^4.2.0`。codemod 应从 `mcp-server-node/` 包根运行，之后必须检查 `@mcp-codemod-error`、包外脚本与测试 import。
- SDK v2 与协议 `2026-07-28` 是两个显式分开的迁移：直接构造 `McpServer` 并 `connect(StdioServerTransport)` 默认仍走 2025-era；stdio 只有改用 `serveStdio(factory)` 才启用 modern era。
- v2 客户端协商支持 legacy（默认）、auto（先 `server/discover`，失败回退 initialize）与 modern pin；服务端双时代是正式迁移路径，不需要一次切断旧客户端。
- SDK v2 支持 v1/v2 包并存以分阶段迁移，但两套包的类/nominal types 不应在同一对象边界混用；本仓库单一 stdio 进程更适合在隔离分支一次完成 imports，再用发布阶段而非运行时混包来渐进。
- v2 build layout 改为扁平 `.mjs`/`.cjs` 且常量可能位于 content-hashed chunk；仓库 `scripts/schema-budget.mjs` 这类读取 SDK dist 文本的脚本必须按目录扫描并允许单双引号，不能只替换包名。
- v2 stdio 新增默认 10 MB `maxBufferSize`，超限会触发 error 并关闭连接；oh-memos 当前工具输入上限最高约 5 MB，仍需加入边界测试以确认 JSON-RPC envelope 不越限。
- `setRequestHandler` 的 method-string、handler `ctx`、Errors/OAuth 等迁移主要影响低层/HTTP/客户端代码；当前服务以 high-level `registerTool` + stdio 为主，因此实施文件面预计较小，但必须全仓 grep 以防测试/脚本隐藏 import。
- v2 的 `registerTool` 正式要求 Standard Schema 对象；raw Zod shape 只剩 deprecated overload。Zod 3 可能在 typecheck/启动阶段不报错，却在首次 `tools/list` 转 JSON Schema 时失败，因此 Phase 1 验收必须包含真实 list/call，而不仅是 build。
- Zod `>=4.2` 才提供完整 `~standard.jsonSchema` 自转换并保留 `.describe()` 描述；4.0-4.1 fallback 可能丢字段描述。计划应直接升级到 `^4.2.0`，并对当前 17 个工具的 schema snapshot/budget 做回归。
- 当前服务未使用低层 request/notification handler、HTTP transport、OAuth、Roots/Sampling/Logging，因此这些 v2 API breaking changes列入审计清单但不应扩大首轮改动。
- v2 将 wire `ProtocolError`、本地 `SdkError` 和 HTTP `SdkHttpError` 分开；oh-memos 当前 stdio high-level handler 没有显式依赖这些类，因此不需要为迁移主动引入新的错误抽象，只需让现有错误回归测试验证文本和 `isError` 语义不变。
- OAuth v2 包含 issuer 绑定、TLS、scope step-up 等大量 breaking/security change，但本仓库 Node MCP 不提供 HTTP/OAuth transport；首轮明确列为 non-goal，避免把本地 stdio 升级扩大成远程服务改造。
- raw spec Zod `*Schema` 常量移到 `@modelcontextprotocol/core`；只有实际 import 这些常量的文件才需要该 direct dependency。最终依赖清单应由 codemod结果 + 全仓 import 审计决定，而不是预先添加全部 v2 包。
- Zod 4 / SDK v2 会把 `tools/list` 中生成的 schema 改为 JSON Schema 2020-12 表达，`additionalProperties` 等细节可能改变；因此“schema 不变”只能定义为字段、必填性、枚举、默认值、上下限和描述语义不变，不能要求 wire JSON 字节相同。
- schema budget 必须在 Phase 1 有意识地 rebaseline，并增加 semantic diff/snapshot 审阅；否则单纯 0% 字节预算既可能误报合法 dialect 漂移，也可能漏掉约束变化。
- v2 对 unknown/disabled tool 从 `CallToolResult{isError:true}` 改为 JSON-RPC `InvalidParams` rejection。条件启用的 `memos_delete` 及不存在工具调用需要双时代契约测试并在 release notes 标明 SDK 层行为差异。
- v2 保持 `Transport` 的 `onmessage` / `send` / `close` 合同，仅新增 optional members；当前 `src/server.ts` 的 transport wrapper 原理上可迁移，但 `serveStdio(factory)` 会改变 transport 所有权，需抽成受测 adapter/hook，而不是继续在入口中隐式 monkey-patch。
- `serveStdio(() => buildServer())` 是 stdio 启用 `2026-07-28` 的唯一正式入口；连接开始时选定 protocol era，并为该连接创建一份 server factory 实例。首发保持 legacy 服务而非 `{ legacy: "reject" }`，以兼容 initialize-era 客户端。
- 当前 server 没有按 `sessionId` 保存 MCP 会话状态，因此不需要引入 `requestState`；MRTR / input_required 只在后续真的需要 server→client 交互时再设计，并要求签名/过期/bind 验证。
- 2026-era 把日志级别改为请求 `_meta`，默认未声明 logLevel 时 `ctx.mcpReq.log()` 不发送消息；本仓库不依赖 MCP logging，故只需避免把 stdout 诊断误当作协议日志。
- 现代 era 的 codec 对已删除 spec 方法会本地拒绝；没有 Tasks、Sampling、Roots 等既有 handler 的本仓库可以安全地把它们列入“不新增/不迁移”的明确边界。
- SDK 在 modern era 内部消费/补齐 `resultType`、reserved `_meta` envelope 和 serverInfo，high-level tool handler 不应手工读写这些 wire-only 字段；迁移无需污染现有 handler result 对象。
- `ttlMs` / `cacheScope` 在 modern era 由 SDK 始终发出，默认 `0` / `private`；首轮协议升级无需给 17 个工具逐个加 cache 配置，后续可按读多写少工具实测再设置 `ServerOptions.cacheHints`。
- `subscriptions/listen` 由 serving entry 自动处理，现有 stdio server 又没有动态 tool/resource list_changed 工作流，因此首轮不需要新建通知总线。
- 官方 behavior matrix 明确 `serveStdio(factory)` 除非设置 `legacy:'reject'` 会同时服务 2025-era；这确认 canary 应使用默认双时代，并把 modern-only 作为稳定运行后的独立决策门。
- `src/server.ts` 当前把 server 创建、tool 注册、transport 连接、quirk normalization 和 background init 集中在 `runServer()`；迁移需要抽出同步 `buildServer(): McpServer`，让 `serveStdio(buildServer)` 能为连接创建实例。
- `tolerateStringArguments()` 必须在 `server.connect()` 安装 SDK handler 后包装 `transport.onmessage`；切换 `serveStdio` 后入口不再直接持有 transport，因此这是本仓库最需要先做兼容 spike/回归测试的自定义行为。
- background init 当前刻意在 handshake 完成后异步启动。`serveStdio` 可能长期占用 await，因此迁移设计要保证初始化仍是 fire-and-forget 且不阻塞首个协议交换，不能简单把现有顺序机械搬到 await 之后。
- `package.json` 当前公开基线为 `oh-memos-mcp@2.1.0`、Node `>=18.0.0`、SDK `^1.12.0`、Zod `^3.25.0`；Node/Zod/SDK 三项都属于 v2 迁移面。
- lockfile 实际解析为 SDK `1.27.1`、Zod `3.25.76`；实施前 Phase 0 可先升到 v1 最新 `1.29.x` 建立更接近 v2 shared 2025-era behavior 的维护基线。
- `tools-registry.ts` 的全部工具已经传入 `z.object(...)`，不是 deprecated raw shape；Zod 4.2 迁移风险主要是行为/生成 JSON Schema 漂移，而非逐工具手工包裹。
- `scripts/schema-budget.mjs` 直接 import 已被 v2 移除的 `server/zod-json-schema-compat.js` / `toJsonSchemaCompat`，是已确认的手工迁移文件；应改成调用 v2 Standard Schema JSON conversion 或通过真实 `tools/list` 测量 wire entry。
- 当前 19 个测试文件没有专门的 server/stdio/protocol-era 契约测试。计划需新增 server factory 单测、legacy client handshake、modern pin/discover、auto negotiation、17-tool list/call 和 stringified-arguments quirk 测试。
- 当前 `schema-baseline.json` 为 17 tools / 18043 B total / 16618 B always-on；这一份代码基线覆盖 16 个默认工具和条件启用的 `memos_delete`，迁移后的 rebaseline 必须逐工具审阅。
- `.github/workflows/ci.yml` 已使用 Node 20，并执行 build、Vitest、schema budget；迁移只需在该 job 增加 protocol smoke/contract gate，无需另改 runner 版本。
- lockfile 下载源为 `registry.npmmirror.com`；官方指出镜像可能滞后于 v2 scoped packages，因此 Phase 0 必须验证镜像可用性并记录切换 public npm registry 的可回滚办法。
- 2026-08-18 实测 public npm 与 npmmirror 均已提供 `@modelcontextprotocol/server@2.0.0`，声明 Node `>=20`、Zod `^4.2.0`、core `2.0.0`；镜像同步当前不是 blocker，但 CI 仍应保留 registry 诊断。
- 两个 registry 均显示 v1 最新为 `@modelcontextprotocol/sdk@1.30.0`，因此 Phase 0 明确先从 lock `1.27.1` 升到 `1.30.0`，建立可独立回滚的最新 legacy baseline。
- CI 已使用 Node 20，构建流水线无需先升级 runner；breaking impact 主要落在 npm consumers、Lite 用户和文档仍承诺的 Node 18+。
- Node 18 承诺散落在 `package.json`、`mcp-server-node/README.md`、根 `README.md` / `README_CN.md`、`docs/DEPLOYMENT_MODES.md`、`docs/MCP_GUIDE.md`；稳定 3.0.0 前必须一次性同步，避免 README 与 engines 漂移。
- `mcp-server-node/CHANGELOG.md` 明确遵循 SemVer，Node 20 minimum + SDK package split 应作为 3.0.0 breaking release；npm `2.x` 可保留为 Node 18 / legacy protocol maintenance line，而不是覆盖 latest 后让旧环境突然无法启动。
- Python `mcp-server/DEPRECATED.md` 再次确认只迁 Node 服务；无需用 SDK v2 计划复活或同步 Python MCP。
- `serveStdio(factory)` 同步返回 `StdioServerHandle`，入口无需 `await` 才能继续注册 SIGINT/启动其他非阻塞工作；但任何进程级 background init 仍会在 auto probe 的 disposable sibling 中运行。
- 为避免 `server/discover` 探测进程访问 API/注册 cube，推荐把 `backgroundInit()` 改为 `startBackgroundInitOnce()`，由第一次真实 tool call 触发；现有 handler 本就能在首调用懒注册，因此不牺牲正确性，只取消无用的预热副作用。
- `serveStdio` 负责 transport 和 protocol era，返回 handle 可用于 SIGINT clean shutdown；计划应把 graceful close 加入新入口测试，而不是继续依赖进程退出隐式清理。
- 官方 legacy guide 明确 stdio 默认 posture 是 `legacy: 'serve'`；计划可以显式写出该值增强可读性，但行为上省略 option 也同样双时代。
- modern-only `{ legacy:'reject' }` 会拒绝 initialize-era opening 但保持连接等待 modern opening；这应作为未来移除旧协议的单独 major/policy gate，不纳入 3.0.0 首发。
- 已发布 `@modelcontextprotocol/server@2.0.0` 的 `ServeStdioOptions` 支持自带 `transport?: Transport`；可新增 `NormalizingStdioTransport` decorator，在把 message 交给 `serveStdio` 前解析字符串化 `params.arguments` 并调用 `recordRawArgKeys`。
- decorator 方案消除“serveStdio 先 start、随后再覆写 onmessage”的竞态，也让 legacy/modern/probe 三条路径共享同一兼容逻辑；原 `tolerateStringArguments()` 可由受测 transport 模块替代。
- v2 源码说明 `server/discover` probe 会构造 optimistic modern instance，fallback 时 factory 可能再构造一次 legacy instance；`buildServer` 必须 cheap 且 side-effect-free，不能在 factory 内启动 background init 或注册 cube。
- `serveStdio` 的 `onerror` 只做 out-of-band reporting，适合接现有 `logger.exception`；custom transport仍由 entry 统一 start/close，SIGINT 只调用返回 handle 的 `close()`。

---

# MCP SDK v2 Phase 3.3 真实 host canary 发现 — 2026-08-19

- Claude Code `2.1.220` 在隔离 `--mcp-config` 下协商 `2025-11-25`，返回 16 个默认工具；完整 Lite suggest/save/search/get 与第二进程 search/get 均成功。
- Codex `0.147.0` 在临时命令行 MCP 覆盖下协商 `2025-06-18`，返回 16 个默认工具；完整 Lite suggest/save/search/get 与第二进程 search/get 均成功。Codex 的 `--ignore-user-config` 独立尝试因 API 401 未进入工具调用，不能作为服务端失败证据。
- Qwen `0.21.13` 在临时 `QWEN_HOME`、OAuth 凭据副本和去掉 `mcpServers` 的 settings 下协商 `2025-11-25`，返回 16 个默认工具；首进程 save/search 成功，第二进程 search/get 成功。首进程模型墙钟超时只影响后续 get，未影响持久化。
- 三个 host 的真实协议版本均为 legacy 2025-era；仓库已验证的 modern `2026-07-28` 能力来自 v2 client/协议矩阵，不能从 host canary 推断现代 host 已普遍升级。
- 所有 canary 写入均落在临时 Lite cube，relay 只输出 direction/method/id/protocolVersion/toolName/toolCount/error flags；未把 prompt、arguments、结果或凭据写入日志。第二进程回读是持久性证据，不依赖向量索引延迟。
- Node server 的 local provider 仍要求 `MEMOS_USER`；缺失时日志为 `MEMOS_USER is required` 并在 initialize 前退出。发布/人工 canary runbook 必须把该变量列为必填。
- Qwen 的一次 `qwen mcp list` 仅在隔离 `QWEN_HOME` 执行；主配置未再次列出。此前主配置输出曾暴露第三方 API key，后续审计应轮换/检查该 key，且不得把它写入仓库、记忆或报告。

---

# MCP SDK v1.30 Phase 0 实施发现 — 2026-08-18

## 依赖与锁定

- `mcp-server-node/package.json` 现在声明 `@modelcontextprotocol/sdk: ^1.30.0`；`package-lock.json` 精确解析为 `1.30.0`，并恢复使用仓库既有的 `registry.npmmirror.com` resolved 地址。
- 本阶段没有修改 `engines.node`、Zod、工具实现、server entry 或 npm 包版本；因此仍是 `oh-memos-mcp@2.1.0` 的 Node 18 / legacy-wire 维护基线。
- `npm ci` 报告 10 个依赖审计项（2 low、1 moderate、6 high、1 critical）。它们在升级前后数量相同，本阶段不做无关的安全升级。

## 合同基线

- 新增 `src/protocol-contract.test.ts`，21 个测试锁定 17 个工具的确定性顺序、17 组 annotations、经环境默认 cube 归一化后的业务 schema 语义哈希，以及 `checkArgContract` / `recordRawArgKeys` 的既有行为。
- 新增 `scripts/protocol-smoke.mjs` 与 `test:protocol`，用 raw JSON-RPC 子进程覆盖 `2025-11-25` initialize、16/17 工具条件列表、Lite JSONL save/search、stringified `params.arguments`、unknown key 非致命、非法参数、Full capability 成功文本和 API error 文本。
- SDK `1.27.1` 基线与 `1.30.0` 升级后的同一套合同均通过；升级没有观察到工具顺序、annotations、schema 业务约束或代表性文本变化。
- 完整 Vitest 从 19 files / 154 tests 变为 20 files / 175 tests，新增 21 个合同测试全部通过；build、schema budget、Lite smoke 和 protocol smoke 全部通过。

## 重要兼容陷阱

- `src/server.ts` 的 transport wrapper 确实调用 `recordRawArgKeys()`，但全仓没有生产代码调用 `checkArgContract()`。因此当前 wire 行为是未知参数被 Zod 丢弃且调用继续，不会把预期的 `IGNORED_ARGS` 警告返回给客户端。
- Phase 0 合同只锁定这个事实：unknown key 不致命，并单测未接线的审计辅助函数；不要在 SDK v2 迁移中顺手接线，否则会把协议迁移和业务文本变更混为一项。若要启用警告，应单独立项并补跨 era transcript。
- schema budget 的总字节数受 `MEMOS_DEFAULT_CUBE` 字符串长度影响：CI fixture `ci_cube` 得到 18033 B，仓库冻结文件为 18043 B。Phase 1 改为真实 `tools/list` + semantic diff 时，应把环境默认值归一化或明确使用固定 fixture，避免误报。

## Phase 0 回滚点

- 只需将 package 与 lockfile 的 SDK 版本退回 `1.27.1` 即可恢复原 direct-connect 行为；新增合同测试和 smoke 脚本不依赖 v2 API，可继续用于回归比较。

---

# MCP SDK v2 Phase 1 实施发现 — 2026-08-18

## 当前迁移面

- Phase 0 分支已推送且 worktree 清洁，可以在同一隔离分支继续演进，不需要新建或切换 worktree。
- 当前本机运行时为 Node `24.12.0`，只能作为额外兼容信号；计划要求的发布门禁仍是 Node 20 与 Node 22。
- CI 已固定 Node 20，但尚未执行 protocol smoke；Phase 1 如修改 workflow，只应补现有脚本门禁，不提前增加 modern era 测试。
- 旧 SDK import 只剩 server entry、protocol semantic test 和 schema budget 三处；业务 handler 与 17 个工具 schema 没有直接依赖 MCP raw spec 类型。
- 本地 `mcp-builder` TypeScript 参考仍使用 monolithic SDK / Node 18 / Zod 3 示例，因此只能提供通用 stdio 与工具设计原则，不能覆盖本阶段的 v2 package split 细节。
- 在完整 CI fixture 下，Zod 4 的 Standard Schema 2020-12 转换会让 17 个 schema 的当前语义哈希全部变化；顺序、annotations 和 arg-contract 断言保持绿色。必须先对 Phase 0 / Phase 1 的真实 `tools/list` 做逐字段 diff，再决定 rebaseline。
- 从 Phase 0 提交 `175f8eb` 与当前 Phase 1 分别启动真实 stdio server 后，17 个工具的名称、顺序、描述、annotations、required/optional、enum/default、字段描述和嵌套 properties 均一致。
- 真实 wire 差异限定为四类：旧 v1 entry 的 `execution.taskSupport: "forbidden"` 在 server v2 direct-connect 输出中消失；`$schema` 从 draft-07 切到 2020-12；Zod object 不再输出根级 `additionalProperties: false`（`memos_search.context.items` 同样如此）；无显式范围的 `z.number().int()` 新增 `Number.MIN_SAFE_INTEGER` / `MAX_SAFE_INTEGER` 边界。
- `additionalProperties` 的 wire 放宽与现有运行时相符：这些 `z.object()` 一直采用 strip 行为，Phase 0 smoke 已冻结 unknown key 非致命且无 wire warning。若为恢复 `false` 改用 `.strict()`，反而会破坏已冻结运行时合同。

## Phase 1 不变项

- 保持 direct `server.connect(new StdioServerTransport())`，不引入 `serveStdio`、`server/discover` 或每请求版本协商。
- 保持 stringified `arguments` normalization、raw key 捕获和 unknown-key 非致命且无 wire warning 的既有行为。
- 不新增 structured output、cache hints、MRTR、Tasks、HTTP/OAuth 或业务工具变更。
- Node 版本提示必须在 `@modelcontextprotocol/server` 与配置模块加载前执行；`index.ts` 因此只静态导入无依赖的版本判断模块，并动态导入 server/config。
- 条件删除工具的 Phase 1 call smoke 使用 Lite provider：它能证明 v2 注册/验证/dispatch 链可调用，同时在触达任何删除 API 前由现有 Full-only 边界安全返回。

## Codemod dry-run

- 使用官方 `@modelcontextprotocol/codemod@2.0.0` 从 `mcp-server-node/` 包根执行。
- 自动迁移范围只有 `src/server.ts` 两处 import；package 计划删除 monolithic SDK 并新增 server 角色包。
- `scripts/schema-budget.mjs` 与 `src/protocol-contract.test.ts` 依赖 v1 私有 `zod-json-schema-compat`，codemod 明确要求手工迁移。
- `inputSchema` warning 是 codemod 无法跨 `toolSchemas` 注册表证明 schema object；代码审计已确认 17 个 schema 均由 `z.object()` 构造。

## Phase 1 最终收尾 — 2026-08-18

- `tsx@4.21.0` 引入的 `esbuild@0.27.3` 低危 Windows 开发服务告警已通过升级 `tsx@4.23.12` 清除；生产依赖审计和完整审计均为 0 vulnerabilities。
- 干净安装后 Node 24、20、22 的 build、178 项测试、真实 legacy `tools/list` schema budget、Lite/Full/条件删除 protocol smoke 全部通过；预算固定为 17 tools / 17981 B / 16581 B always-on，漂移 0.0%。
- Node 18.20.8 运行入口时在导入 SDK/config 之前退出码 1，并输出 `oh-memos-mcp requires Node.js >=20.0.0`；这使 breaking runtime requirement 可诊断而非隐式模块错误。
- 最终全仓审计无旧 monolithic SDK import、codemod marker、`serveStdio` 或 `2026-07-28` modern-era 标记。Phase 1 明确保持 direct-connect `2025-11-25` legacy wire，Phase 2 的双时代 serving 仍未启动。
- Windows worktree 的 `git diff --check` 需使用 `core.whitespace=cr-at-eol` 解读 CRLF；提交前仍须检查 staged diff，避免把行尾提示误判为真实空白。

---

# MCP SDK v2 Phase 3 实施发现 — 2026-08-18

- 当前迁移 worktree 清洁，分支 `docs/mcp-v2-migration-plan` 的 HEAD/远端均为 `d8081e2`；主工作区 `G:\test\oh-memos` 的无关未跟踪文件必须保持原样。
- Phase 3 计划要求的多数行为已经存在于 `protocol-v2-smoke.mjs`，但现有脚本主要固定 Lite + 16 工具，尚未系统断言 Full 配置、条件 `memos_delete`、空/未知参数、语义 schema snapshot、打包文件边界和 CI Node matrix。
- `package.json` 的 `@modelcontextprotocol/client` 是 devDependency，`files` 白名单只包含 dist/README/CHANGELOG/.env.example；`npm pack --dry-run` 应验证 client harness 不进入 tarball。
- 当前 CI 只有 Ubuntu Node 20；Phase 3 可用一个 Node 20/22 matrix 保持 Python job 独立，再加 Windows release/branch smoke，避免重复安装 Python 依赖。
- 真实 host canary 不能在未确认 Claude Code/Codex/Qwen 可执行入口或登录态时伪造通过结果；自动化矩阵应先成为可审计门禁，host 结果单独记录为可用/不可用。

## Phase 3 验证与错误记录

- 首次并行运行 `npm test` 未传 CI fixture，5 个 suite 在收集阶段因 `MEMOS_URL is required` 失败；按 workflow 传入 `MEMOS_URL`、`MEMOS_USER`、`MEMOS_DEFAULT_CUBE`、`MEMOS_CUBES_DIR` 后重跑为 24 files / 184 tests 通过。
- Windows 首次运行 pack contract 时 `spawnSync npm.cmd` 返回 `EINVAL`；改为通过 `%ComSpec% /d /s /c` 调用 `npm.cmd`，随后 dry-run 94 files 通过且不再出现 Node shell 参数弃用警告。
- 语义 snapshot 基线必须加入 `.gitignore` 例外；仓库有全局 `*.json` 忽略规则，已新增 `!mcp-server-node/schema-semantic-baseline.json`，否则 CI checkout 会缺基线。
- 当前本机 Node 24.12.0 可直接运行全部门禁；Node 20/22 由 CI matrix 覆盖，本轮未改动其安装器或本机默认 Node。
- Claude Code 2.1.220、Codex 0.147.0、Qwen 0.21.13 均可执行，现有 `oh-memos` 主工作区注册在三者 health/list 检查中连接；迁移 worktree 的真实 host list/call/reconnect 需要隔离配置和模型 API 调用，保留为人工发布门禁。

---

# MCP SDK v2 Phase 4.1 本地发布包门禁发现 — 2026-08-19

- 真实 `npm pack --json` 生成的 `oh-memos-mcp-2.1.0.tgz` 大小为 117254 bytes；全新目录安装后，`engines.node`、bin、dist 入口和 files 边界与 package 合同一致，源码没有进入安装包。
- 安装包目录中的 `dist/index.js` 在 Lite 模式下可独立完成 initialize、16-tool `tools/list`、`memos_save`、`memos_search` 和 `memos_get`；JSONL 中同一 ID 的跨调用回读证明发布包没有依赖工作区源码或开发依赖。
- `scripts/lite-smoke-test.mjs` 使用相对路径 `dist/index.js`，执行已安装包时 cwd 必须是 `node_modules/oh-memos-mcp`，而不是 npm install 的父目录；这条约束应写入未来 registry smoke runbook。
- 本地 tarball 证据不等于 registry canary：当前没有发布 `3.0.0-next`，因此不能声称 `npx @next` 或 npm `next` dist-tag 已验证；7 天观察窗口也仍是 pending。
- 临时目录已精确清理。之前诊断阶段曾有凭据出现在终端输出，未进入提交或项目记忆；维护者仍应立即撤销/轮换受影响凭据，后续报告不得复述具体值。
