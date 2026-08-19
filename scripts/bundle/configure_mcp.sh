#!/bin/bash

# oh-memos MCP Configuration for Claude Code
# 自动配置 MCP 到 Claude Code

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo "========================================"
echo "  oh-memos MCP 配置工具"
echo "  Configure MCP for Claude Code"
echo "========================================"
echo ""

# Claude Code 配置文件路径
CLAUDE_CONFIG_DIR="$HOME/.claude"
CLAUDE_CONFIG="$CLAUDE_CONFIG_DIR/settings.json"

# 检查 Claude Code 配置目录
if [ ! -d "$CLAUDE_CONFIG_DIR" ]; then
    echo "[INFO] 创建 Claude Code 配置目录..."
    mkdir -p "$CLAUDE_CONFIG_DIR"
fi

# MCP server 走 npm 包 oh-memos-mcp（纯 Node，无需 Python），由 npx 按需拉取。
# 数据仍留在 bundle 内，故 MEMOS_CUBES_DIR 指向 BUNDLE_ROOT。
MCP_PACKAGE="oh-memos-mcp"
CUBES_DIR="$BUNDLE_ROOT/data/oh-memos_cubes"

# npx 是必需项：没有它下面生成的配置启动不了
if ! command -v npx >/dev/null 2>&1; then
    echo -e "  ${YELLOW}[WARN] 未在 PATH 中找到 npx${NC}"
    echo "  oh-memos MCP server 以 npm 包形式分发，需要 Node.js >= 20。"
    echo "  请先安装 Node.js: https://nodejs.org/"
    echo "  安装后重新运行本脚本。配置仍会生成，但在装好 Node 之前无法启动。"
    echo ""
else
    echo "  [OK] npx: $(command -v npx)  (node $(node --version 2>/dev/null || echo '?'))"
    echo ""
fi

echo ""
echo "================================================"
echo -e "  ${CYAN}MCP 配置信息 (oh-memos)${NC}"
echo "================================================"
echo ""
echo "  请将以下配置添加到您的 Claude Code settings:"
echo ""
echo -e "  ${YELLOW}方式1: 使用 Claude Code 命令${NC}"
echo "  ----------------------------------"
echo "  在 Claude Code 中运行:"
echo ""
echo "  /mcp add oh-memos"
echo ""
echo "  然后输入以下配置:"
echo "  - command: npx"
echo "  - args: -y $MCP_PACKAGE"
echo ""
echo ""
echo -e "  ${YELLOW}方式2: 手动编辑配置文件${NC}"
echo "  ----------------------------------"
echo "  编辑文件: $CLAUDE_CONFIG"
echo ""
echo "  添加以下内容到 \"mcpServers\" 部分:"
echo ""
cat << EOF
  {
    "mcpServers": {
      "oh-memos": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "$MCP_PACKAGE"],
        "env": {
          "MEMOS_URL": "http://localhost:18000",
          "MEMOS_USER": "dev_user",
          "MEMOS_DEFAULT_CUBE": "dev_cube",
          "MEMOS_CUBES_DIR": "$CUBES_DIR"
        }
      }
    }
  }
EOF
echo ""
echo "================================================"
echo ""

# 生成配置模板文件
MCP_CONFIG_FILE="$BUNDLE_ROOT/mcp-config.json"

echo "正在生成配置模板文件..."
cat > "$MCP_CONFIG_FILE" << EOF
{
  "mcpServers": {
    "oh-memos": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "$MCP_PACKAGE"],
      "env": {
        "MEMOS_URL": "http://localhost:18000",
        "MEMOS_USER": "dev_user",
        "MEMOS_DEFAULT_CUBE": "dev_cube",
        "MEMOS_CUBES_DIR": "$CUBES_DIR"
      }
    }
  }
}
EOF

echo ""
echo -e "配置模板已保存到: ${GREEN}$MCP_CONFIG_FILE${NC}"
echo ""
echo "================================================"
echo "  下一步 Next Steps"
echo "================================================"
echo ""
echo "  1. 启动 oh-memos 服务: ./start.sh"
echo "  2. 在 Claude Code 中使用 memos_* 工具"
echo ""
echo "  可用工具 Available Tools (10):"
echo "  - memos_context_resume : 恢复项目上下文(会话开始/压缩后)"
echo "  - memos_search         : 搜索记忆(可带 context 做上下文感知)"
echo "  - memos_save           : 保存记忆(必须显式指定 memory_type)"
echo "  - memos_list_v2        : 列出记忆"
echo "  - memos_get            : 按 ID 取记忆详情"
echo "  - memos_suggest        : 查询建议 + memory_type 决策树"
echo "  - memos_think          : 证据包 + 缺口分析"
echo "  - memos_graph          : 知识图谱(mode=related/path/impact/schema)"
echo "  - memos_admin          : 维护(action=list_cubes/register_cube/stats/calendar...)"
echo "  - memos_export_wiki    : 导出互链 markdown wiki"
echo ""
echo "================================================"
echo ""
