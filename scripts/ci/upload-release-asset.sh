#!/usr/bin/env bash
set -euo pipefail

release_tag=${1:?usage: upload-release-asset.sh <vX.Y.Z tag>}
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

if ! gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" >/dev/null; then
    echo "ERROR: expected GitHub Release $release_tag does not exist" >&2
    exit 1
fi

shopt -s nullglob
packages=(*.tgz)
if (( ${#packages[@]} != 1 )); then
    echo "ERROR: expected exactly one .tgz package, found ${#packages[@]}" >&2
    exit 1
fi

gh release upload "$release_tag" "${packages[0]}" \
    --repo "$GITHUB_REPOSITORY" \
    --clobber
