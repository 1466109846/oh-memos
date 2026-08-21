#!/bin/bash
# oh-memos Node MCP launcher for WSL Claude Code.
#
# Runs the Node MCP (mcp-server-node/dist/index.js) as a native Linux process.
# In WSL2 NAT mode, WSL's localhost is NOT the Windows host, so the MemOS API
# (a Windows process on localhost:18000) is reachable only via the default-route
# gateway IP. Compute it fresh at launch so it survives WSL IP changes.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

# Mirrored mode: WSL shares the Windows network stack, so localhost IS the host
# and the default-route gateway is the physical router — probe before trusting it.
if curl -sf -o /dev/null --max-time 2 http://localhost:18000/health 2>/dev/null; then
    export MEMOS_URL="http://localhost:18000"
else
    WINIP="$(ip route show default 2>/dev/null | awk '{print $3}' | head -1)"
    if [ -n "$WINIP" ] && curl -sf -o /dev/null --max-time 2 "http://${WINIP}:18000/health" 2>/dev/null; then
        export MEMOS_URL="http://${WINIP}:18000"
    fi
fi

exec /home/xigou/.nvm/versions/node/v24.12.0/bin/node dist/index.js "$@"
