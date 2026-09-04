#!/usr/bin/env bash
set -euo pipefail

archive_input=${1:?usage: package-smoke.sh PACKAGE.tgz}
archive_dir=$(CDPATH='' cd -- "$(dirname -- "$archive_input")" && pwd)
archive="$archive_dir/$(basename -- "$archive_input")"
repo_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
smoke_dir=$(mktemp -d)
server_pid=

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
tar -xzf "$archive" -C "$smoke_dir"

test -f "$smoke_dir/package/dist/main.js"
test "$(node -p "require('$smoke_dir/package/package.json').bin['obsidian-sync-mcp']")" = "dist/main.js"

# Install exactly the reviewed production graph outside the checkout. This
# prevents Node from satisfying missing package dependencies via node_modules
# in the repository while keeping the smoke test independent of the registry.
cp "$repo_root/pnpm-lock.yaml" "$repo_root/pnpm-workspace.yaml" "$smoke_dir/package/"
pnpm --dir "$smoke_dir/package" install \
    --prod \
    --frozen-lockfile \
    --offline \
    --trust-lockfile

PORT=9876 \
VAULT_PATH="$smoke_dir/vault" \
DATA_DIR="$smoke_dir/data" \
MCP_AUTH_TOKEN=ci-test-token \
node "$smoke_dir/package/dist/main.js" >"$smoke_dir/server.log" 2>&1 &
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
