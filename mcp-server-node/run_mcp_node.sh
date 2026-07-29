#!/bin/bash
# oh-memos Node MCP launcher for WSL Claude Code.
#
# Runs the Node MCP (mcp-server-node/dist/index.js) as a native Linux process.
# In WSL2 NAT mode, WSL's localhost is NOT the Windows host, so the MemOS API
# (a Windows process on localhost:18000) is reachable only via the default-route
# gateway IP. Compute it fresh at launch so it survives WSL IP changes.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

WINIP="$(ip route show default 2>/dev/null | awk '{print $3}' | head -1)"
if [ -n "$WINIP" ]; then
    export MEMOS_URL="http://${WINIP}:18000"
fi

exec /home/xigou/.nvm/versions/node/v24.12.0/bin/node dist/index.js "$@"
