#!/usr/bin/env bash
set -euo pipefail

archive_input=${1:?usage: package-smoke.sh PACKAGE.tgz [pnpm|npm]}
archive_dir=$(CDPATH='' cd -- "$(dirname -- "$archive_input")" && pwd)
archive="$archive_dir/$(basename -- "$archive_input")"
repo_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
smoke_dir=$(mktemp -d)
server_pid=
package_dir="$smoke_dir/package"
installer=${2:-pnpm}

# shellcheck disable=SC2329 # Invoked indirectly by the EXIT trap.
cleanup() {
    if [[ -n "$server_pid" ]]; then
        kill "$server_pid" >/dev/null 2>&1 || true
        wait "$server_pid" >/dev/null 2>&1 || true
    fi
    rm -rf -- "$smoke_dir"
}
trap cleanup EXIT

mkdir -p "$smoke_dir/vault" "$smoke_dir/data"
case "$installer" in
    pnpm)
        tar -xzf "$archive" -C "$smoke_dir"
        # Install the reviewed production graph outside the checkout.
        cp "$repo_root/pnpm-lock.yaml" "$repo_root/pnpm-workspace.yaml" "$package_dir/"
        pnpm --dir "$package_dir" install --prod --frozen-lockfile --offline --trust-lockfile
        ;;
    npm)
        # Exercise a real npm consumer, including package lifecycle and bin setup.
        mkdir -p "$smoke_dir/consumer"
        npm --prefix "$smoke_dir/consumer" install --omit=dev --no-audit --no-fund "$archive"
        package_dir="$smoke_dir/consumer/node_modules/obsidian-sync-mcp"
        test -x "$smoke_dir/consumer/node_modules/.bin/obsidian-sync-mcp"
        ;;
    *) echo "Unknown installer: $installer" >&2; exit 2 ;;
esac

test -f "$package_dir/dist/main.js"
test "$(node -p "require('$package_dir/package.json').bin['obsidian-sync-mcp']")" = "dist/main.js"

# A second logger instance would silently undo production path redaction.
(
    cd "$package_dir"
    node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import * as app from "octagonal-wheels/common/logger";
import * as commonlib from "@vrtmrz/livesync-commonlib/compat/common/logger";
assert.equal(app.Logger, commonlib.Logger);
assert.equal(app.setGlobalLogFunction, commonlib.setGlobalLogFunction);
NODE
)

PORT=9876 \
VAULT_PATH="$smoke_dir/vault" \
DATA_DIR="$smoke_dir/data" \
MCP_AUTH_TOKEN=ci-test-token \
node "$package_dir/dist/main.js" >"$smoke_dir/server.log" 2>&1 &
server_pid=$!

for _attempt in {1..50}; do
    if node --input-type=module --eval \
        "const response = await fetch('http://127.0.0.1:9876/health'); if (!response.ok) process.exit(1)" \
        >/dev/null 2>&1; then
        exit 0
    fi
    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
        cat "$smoke_dir/server.log"
        exit 1
    fi
    sleep 0.2
done

cat "$smoke_dir/server.log"
exit 1
