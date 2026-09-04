#!/usr/bin/env bash
set -euo pipefail

repo_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

root_image=obsidian-sync-mcp:ci
mcp_only_image=obsidian-sync-mcp:mcp-only-ci
combined_image=obsidian-sync-mcp:combined-ci
root_container="obsidian-sync-mcp-root-ci-$$"
mcp_only_container="obsidian-sync-mcp-only-ci-$$"
combined_container="obsidian-sync-mcp-combined-ci-$$"

cleanup() {
    docker rm --force "$root_container" "$mcp_only_container" "$combined_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_healthy() {
    local container=$1
    local state

    for _attempt in {1..60}; do
        state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container")
        case "$state" in
            "running healthy") return 0 ;;
            "running unhealthy" | exited*) break ;;
        esac
        sleep 2
    done

    docker logs "$container"
    return 1
}

docker build --tag "$root_image" .
docker build \
    --build-arg "MCP_IMAGE=$root_image" \
    --tag "$mcp_only_image" \
    deploy/mcp-only
docker build \
    --build-arg "MCP_IMAGE=$root_image" \
    --tag "$combined_image" \
    deploy/mcp-with-db

docker run --detach --name "$root_container" \
    --env MCP_AUTH_TOKEN=ci-test-token \
    --env VAULT_PATH=/data/vault \
    "$root_image" \
    sh -c 'mkdir -p /data/vault && exec node dist/main.js'

wait_for_healthy "$root_container"
docker run --detach --name "$mcp_only_container" \
    --env MCP_AUTH_TOKEN=ci-test-token \
    --env VAULT_PATH=/data/vault \
    "$mcp_only_image" \
    sh -c 'mkdir -p /data/vault && exec node dist/main.js'
wait_for_healthy "$mcp_only_container"

docker run --detach --name "$combined_container" \
    --env COUCHDB_USER=admin \
    --env COUCHDB_PASSWORD=ci-test-database-password \
    --env MCP_AUTH_TOKEN=ci-test-token \
    "$combined_image"
wait_for_healthy "$combined_container"
