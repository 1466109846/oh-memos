#!/bin/sh
# oh-memos container entrypoint.
#
# Single job: make sure the default cube exists before the API starts, then hand
# PID 1 over to the API with exec so signals reach uvicorn directly.
#
# Seeding is create-if-missing. An existing cube is never touched — the config
# on disk is the user's, and apply_env_overrides() in
# src/oh_memos/mem_cube/utils.py applies runtime settings from the environment
# on every load, so the seed only ever carries placeholders.
set -eu

CUBES_DIR="${MEMOS_CUBES_DIR:-/data/cubes}"
# Use the default only when the variable is unset. An explicitly empty value is
# an invalid config and must not silently seed a surprising default cube.
DEFAULT_CUBE="${MEMOS_DEFAULT_CUBE-dev_cube}"
SEED_TEMPLATE="${OH_MEMOS_CUBE_SEED:-/opt/oh-memos/dev_cube.config.template}"
RUNTIME_DIR="${MEMOS_BASE_PATH:-/data/runtime}"

log() { printf '[entrypoint] %s\n' "$*"; }
die() { printf '[entrypoint] ERROR: %s\n' "$*" >&2; exit 1; }

# Cube IDs feed directory names, Neo4j's user_name and Qdrant collection names,
# then are rendered into JSON by sed. Keep their contract deliberately small so
# none of those layers needs escaping or interpretation.
case "$DEFAULT_CUBE" in
    '' | *[!A-Za-z0-9_-]*)
        die "MEMOS_DEFAULT_CUBE must contain only letters, digits, '_' or '-', got '$DEFAULT_CUBE'"
        ;;
esac

# The runtime dir holds the SQLite user store and logs. It is a named volume, so
# it may be empty on first boot.
mkdir -p "$RUNTIME_DIR/logs" \
    || die "cannot write runtime dir $RUNTIME_DIR (check volume permissions)"

[ -d "$CUBES_DIR" ] \
    || die "cubes dir $CUBES_DIR is missing (expected a mounted volume)"

CUBE_DIR="$CUBES_DIR/$DEFAULT_CUBE"
CUBE_CONFIG="$CUBE_DIR/config.json"

if [ -f "$CUBE_CONFIG" ]; then
    log "default cube '$DEFAULT_CUBE' already present, leaving it untouched"
else
    [ -f "$SEED_TEMPLATE" ] || die "cube seed template not found at $SEED_TEMPLATE"
    log "seeding default cube '$DEFAULT_CUBE' from template"

    mkdir -p "$CUBE_DIR" \
        || die "cannot create $CUBE_DIR — on Linux hosts the bind-mounted directory must be writable by uid $(id -u)"

    # Write to a temp file and rename so a crash mid-write cannot leave a
    # half-written config.json that the API would then try to parse.
    TMP_CONFIG="$CUBE_DIR/.config.json.$$"
    if ! sed "s/__CUBE_ID__/$DEFAULT_CUBE/g" "$SEED_TEMPLATE" > "$TMP_CONFIG"; then
        rm -f "$TMP_CONFIG"
        die "failed to render cube seed into $CUBE_DIR"
    fi
    if ! mv "$TMP_CONFIG" "$CUBE_CONFIG"; then
        rm -f "$TMP_CONFIG"
        die "failed to install $CUBE_CONFIG"
    fi
    log "created $CUBE_CONFIG (placeholders are replaced from the environment at load time)"
fi

exec "$@"
