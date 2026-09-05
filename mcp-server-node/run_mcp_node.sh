#!/bin/bash
# oh-memos Node MCP launcher for WSL Claude Code.
#
# Runs the Node MCP (mcp-server-node/dist/index.js) as a native Linux process.
# WSL can use mirrored networking, NAT, or a custom DNS setup, so localhost and
# the default route are only candidates. Probe the API before choosing one.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

API_PORT="${MEMOS_API_PORT:-18000}"
API_HEALTH_PATH="${MEMOS_API_HEALTH_PATH:-/health}"
declare -a API_CANDIDATES=()
IS_WSL=0
KERNEL_RELEASE="$(uname -r 2>/dev/null || true)"
if [ -n "${WSL_DISTRO_NAME:-}${WSL_INTEROP:-}" ] || [[ "${KERNEL_RELEASE,,}" == *microsoft* ]] || [[ "${KERNEL_RELEASE,,}" == *wsl* ]]; then
    IS_WSL=1
fi

HAS_URL_ARG=0
HAS_ENV_FILE_ARG=0
ENV_FILE_ARG=""
EXPECT_ENV_FILE_VALUE=0
for arg in "$@"; do
    [ "$arg" = "--" ] && break
    if [ "$EXPECT_ENV_FILE_VALUE" -eq 1 ]; then
        EXPECT_ENV_FILE_VALUE=0
        if [[ "$arg" != --* ]]; then
            ENV_FILE_ARG="$arg"
            continue
        fi
    fi
    case "$arg" in
        --memos-url|--memos-url=*) HAS_URL_ARG=1 ;;
        --memos-env-file)
            HAS_ENV_FILE_ARG=1
            EXPECT_ENV_FILE_VALUE=1
            ;;
        --memos-env-file=*)
            HAS_ENV_FILE_ARG=1
            ENV_FILE_ARG="${arg#*=}"
            ;;
    esac
done

add_candidate() {
    local candidate="${1%%#*}"
    [ -z "$candidate" ] && return
    case "$candidate" in
        http://*|https://*) ;;
        *) return ;;
    esac
    local existing
    for existing in "${API_CANDIDATES[@]}"; do
        [ "$existing" = "$candidate" ] && return
    done
    API_CANDIDATES+=("$candidate")
}

is_loopback_url() {
    local url="$1"
    if [[ "$url" =~ ^(https?)://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(.*)$ ]]; then
        local suffix="${BASH_REMATCH[4]}"
        case "$suffix" in
            ""|/*|\?*|\#*) return 0 ;;
        esac
    fi
    return 1
}

add_host_alias() {
    local url="$1"
    local alias_host="$2"
    is_loopback_url "$url" || return
    [[ "$url" =~ ^(https?)://(localhost|127[.]0[.]0[.]1)(:[0-9]+)?(.*)$ ]]
    add_candidate "${BASH_REMATCH[1]}://${alias_host}${BASH_REMATCH[3]}${BASH_REMATCH[4]}"
}

add_loopback_alias() {
    local url="$1"
    [[ "$url" =~ ^https?://(localhost|127[.]0[.]0[.]1) ]] || return
    local alias_host="localhost"
    [ "${BASH_REMATCH[1]}" = "localhost" ] && alias_host="127.0.0.1"
    add_host_alias "$url" "$alias_host"
}

add_discovered_host() {
    local host="$1"
    if [ -n "$CONFIGURED_URL" ]; then
        add_host_alias "$CONFIGURED_URL" "$host"
    else
        add_candidate "http://${host}:${API_PORT}"
    fi
}

health_url_for() {
    local candidate="$1"
    local base="$candidate"
    local suffix=""
    case "$candidate" in
        *\?*) base="${candidate%%\?*}"; suffix="?${candidate#*\?}" ;;
    esac
    local health_path="/${API_HEALTH_PATH#/}"
    case "$base" in
        */) printf '%s%s%s\n' "$base" "${health_path#/}" "$suffix" ;;
        *) printf '%s%s%s\n' "$base" "$health_path" "$suffix" ;;
    esac
}

EXPLICIT_URL="${MEMOS_URL:-${MEMOS_BASE_URL:-}}"
HAS_ENV_FILE=0
[ -n "${MEMOS_ENV_FILE:-}" ] && HAS_ENV_FILE=1
[ "$HAS_ENV_FILE_ARG" -eq 1 ] && HAS_ENV_FILE=1

is_supported_node() {
    local major
    major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 20 ]
}

NODE_BIN="${MEMOS_NODE_BIN:-}"
NODE_BIN_EXPLICIT="$NODE_BIN"
if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ] && [ -z "$NODE_BIN_EXPLICIT" ] && [ -x "/home/xigou/.nvm/versions/node/v24.12.0/bin/node" ]; then
    NODE_BIN="/home/xigou/.nvm/versions/node/v24.12.0/bin/node"
fi
if [ -n "$NODE_BIN" ] && ! is_supported_node "$NODE_BIN"; then
    if [ -z "$NODE_BIN_EXPLICIT" ] && [ -x "/home/xigou/.nvm/versions/node/v24.12.0/bin/node" ]; then
        NODE_BIN="/home/xigou/.nvm/versions/node/v24.12.0/bin/node"
    else
        NODE_BIN=""
    fi
fi
if [ -n "$NODE_BIN" ] && ! is_supported_node "$NODE_BIN"; then
    NODE_BIN=""
fi
if [ -z "$NODE_BIN" ]; then
    echo "[oh-memos-mcp] Node.js 20+ was not found; set MEMOS_NODE_BIN or add node to PATH." >&2
    exit 127
fi

read_env_memos_url() {
    "$NODE_BIN" --input-type=module -e '
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
try {
  const parsed = dotenv.parse(readFileSync(process.argv[1]));
  const value = [parsed.MEMOS_URL, parsed.MEMOS_BASE_URL]
    .find((entry) => typeof entry === "string" && entry.trim());
  if (typeof value === "string") process.stdout.write(value.trim());
} catch {}
' "$1" 2>/dev/null
}

ENV_FILE_PATH="${ENV_FILE_ARG:-${MEMOS_ENV_FILE:-}}"
CONFIGURED_URL="$EXPLICIT_URL"
if [ -n "$ENV_FILE_PATH" ]; then
    ENV_FILE_URL="$(read_env_memos_url "$ENV_FILE_PATH")"
    [ -n "$ENV_FILE_URL" ] && CONFIGURED_URL="$ENV_FILE_URL"
fi

# CLI URLs and custom hosts are authoritative. A configured loopback URL may
# still need an IPv4 alias or the Windows host address when launched from WSL.
CAN_DISCOVER=1
if [ "$HAS_URL_ARG" -eq 1 ]; then
    CAN_DISCOVER=0
elif [ -n "$CONFIGURED_URL" ] && ! is_loopback_url "$CONFIGURED_URL"; then
    CAN_DISCOVER=0
elif [ -z "$CONFIGURED_URL" ] && [ "$HAS_ENV_FILE" -eq 1 ]; then
    CAN_DISCOVER=0
fi

is_memos_health() {
    "$NODE_BIN" -e '
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(body);
    const status = value?.data?.status ?? value?.data?.overall_status;
    const knownStatus = status === "ok" || status === "degraded" || status === "down";
    if (value?.code === 200 && knownStatus) {
      process.stdout.write(status);
      return;
    }
    process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
});
'
}

if [ "$CAN_DISCOVER" -eq 1 ]; then
    if [ -n "$CONFIGURED_URL" ]; then
        # Preserve scheme, port, path, and query of an inherited URL. A custom
        # HTTPS endpoint must never silently become plain HTTP on port 18000.
        add_candidate "$CONFIGURED_URL"
        add_loopback_alias "$CONFIGURED_URL"
    else
        add_candidate "http://localhost:${API_PORT}"
        add_candidate "http://127.0.0.1:${API_PORT}"
    fi

    # Docker Desktop and several WSL integrations publish the Windows host here.
    add_discovered_host "host.docker.internal"

    # In NAT mode resolv.conf commonly contains the Windows host address.
    if [ "$IS_WSL" -eq 1 ] && [ -r /etc/resolv.conf ]; then
        while read -r directive address _rest; do
            if [ "$directive" = "nameserver" ] && [ -n "$address" ]; then
                case "$address" in
                    127.*|0.0.0.0|::1) continue ;;
                    *:*) address="[$address]" ;;
                esac
                add_discovered_host "$address"
            fi
        done < /etc/resolv.conf
    fi

    # Keep the default gateway as a last-resort candidate for classic WSL NAT.
    if [ "$IS_WSL" -eq 1 ] && command -v ip >/dev/null 2>&1 && command -v awk >/dev/null 2>&1; then
        WINIP="$(ip route show default 2>/dev/null | awk '$1 == "default" { print $3; exit }')"
        [ -n "$WINIP" ] && add_discovered_host "$WINIP"
    fi

    REACHABLE_URL=""
    HEALTHY_URL=""
    for candidate in "${API_CANDIDATES[@]}"; do
        health_url="$(health_url_for "$candidate")"
        health_body="$(curl --noproxy '*' --max-redirs 0 -fsS --connect-timeout 1 --max-time 2 "$health_url" 2>/dev/null)" || continue
        health_status="$(is_memos_health <<< "$health_body")" || continue
        [ -z "$REACHABLE_URL" ] && REACHABLE_URL="$candidate"
        if [ "$health_status" = "ok" ]; then
            HEALTHY_URL="$candidate"
            break
        fi
    done
    SELECTED_URL="${HEALTHY_URL:-$REACHABLE_URL}"

    if [ -n "$SELECTED_URL" ]; then
        export MEMOS_URL="$SELECTED_URL"
    else
        # Keep the configured value so the MCP process can start and return its
        # structured API_UNREACHABLE response instead of failing the handshake.
        export MEMOS_URL="${CONFIGURED_URL:-http://localhost:${API_PORT}}"
        SAFE_URL="${MEMOS_URL%%\?*}"
        SAFE_URL="${SAFE_URL%%#*}"
        echo "[oh-memos-mcp] API health check failed; using MEMOS_URL=${SAFE_URL}" >&2
        echo "[oh-memos-mcp] Check Docker MEMOS_BIND_ADDRESS and WSL host networking." >&2
    fi
fi

if [ "$CAN_DISCOVER" -eq 1 ] && [ "$HAS_URL_ARG" -eq 0 ]; then
    # The selected address must beat a loopback value from an explicit env file.
    # Insert before `--` so Node does not treat the flag as positional.
    declare -a FORWARDED_ARGS=()
    INSERTED=0
    for arg in "$@"; do
        if [ "$INSERTED" -eq 0 ] && [ "$arg" = "--" ]; then
            FORWARDED_ARGS+=(--memos-url "$MEMOS_URL")
            INSERTED=1
        fi
        FORWARDED_ARGS+=("$arg")
    done
    [ "$INSERTED" -eq 0 ] && FORWARDED_ARGS+=(--memos-url "$MEMOS_URL")
    set -- "${FORWARDED_ARGS[@]}"
fi

exec "$NODE_BIN" dist/index.js "$@"
