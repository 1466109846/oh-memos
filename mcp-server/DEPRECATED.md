# ⚠️ DEPRECATED — Python MCP Server

本目录(`mcp-server/`,Python)是 oh-memos 早期的 MCP server 实现,**已停用,请勿在此继续开发**。

当前所有客户端(Claude Code / Codex / Qwen)实际加载的是 **Node 版**:

```
mcp-server-node/dist/index.js   ← 源码 mcp-server-node/src/
```

## 为什么停用

- 两套实现(Python 这份 + Node 那份)曾长期逐模块手工镜像,已经出现**行为漂移**,例如:
  - `getDefaultCubeId` 的优先级:Node 是 env 默认优先,Python 是 CWD 推导优先;
  - 模板缺失时的兜底 cube 配置:两边逻辑不同。
- 客户端配置(`~/.claude.json`、`~/.codex/config.toml`、`~/.qwen/settings.json`)全部指向 Node 版,**没有任何客户端加载本目录**。

## 需要修改 MCP 行为时

改 **`mcp-server-node/`**,改完 `npm run build`(或 `node node_modules/typescript/bin/tsc -p tsconfig.json`)重新生成 `dist/`。

本目录仅保留供参考 / 历史对照。若确需跨运行时双实现,应从单一 spec 生成两端,而不是各写一遍。
