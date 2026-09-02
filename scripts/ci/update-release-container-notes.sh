#!/usr/bin/env bash
set -euo pipefail

tag=${1:?usage: update-release-container-notes.sh <vX.Y.Z tag> <sha256 digest>}
digest=${2:?usage: update-release-container-notes.sh <vX.Y.Z tag> <sha256 digest>}
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "ERROR: invalid release tag: $tag" >&2
    exit 1
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "ERROR: invalid container digest: $digest" >&2
    exit 1
fi

image_ref="ghcr.io/${GITHUB_REPOSITORY}:${tag}@${digest}"
release_body=$(mktemp)
body_without_container=$(mktemp)
updated_body=$(mktemp)
trap 'rm -f "$release_body" "$body_without_container" "$updated_body"' EXIT

if ! gh release view "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --json body \
    --jq '.body // ""' >"$release_body"; then
    echo "ERROR: expected GitHub Release $tag does not exist" >&2
    exit 1
fi

awk '
    /<!-- container-image:start -->/ { in_container = 1; next }
    /<!-- container-image:end -->/ { in_container = 0; next }
    !in_container { print }
' "$release_body" >"$body_without_container"

{
    sed -e ':a' -e '/^[[:space:]]*$/{$d;N;ba' -e '}' "$body_without_container"
    printf '\n\n<!-- container-image:start -->\n'
    printf '## Container image\n\n'
    printf '\140%s\140\n' "$image_ref"
    printf '<!-- container-image:end -->\n'
} >"$updated_body"

gh release edit "$tag" \
    --repo "$GITHUB_REPOSITORY" \
    --notes-file "$updated_body"

echo "Recorded $image_ref in GitHub Release $tag"
