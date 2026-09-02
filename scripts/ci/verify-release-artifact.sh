#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REF:?GITHUB_REF must be set}"
: "${GITHUB_REF_NAME:?GITHUB_REF_NAME must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

package_version=$(node -p "require('./package.json').version")
if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
    release_tag=$GITHUB_REF_NAME
else
    release_tag="v${package_version}"
fi

if [[ "$release_tag" != "v${package_version}" ]]; then
    echo "ERROR: tag $release_tag does not match package.json version $package_version" >&2
    exit 1
fi
if ! git rev-parse --verify --quiet "refs/tags/${release_tag}^{commit}" >/dev/null; then
    echo "ERROR: expected tag $release_tag does not exist" >&2
    exit 1
fi

head_sha=$(git rev-parse HEAD)
tag_sha=$(git rev-list -n 1 "$release_tag")
if [[ "$tag_sha" != "$head_sha" ]]; then
    echo "ERROR: tag $release_tag does not point to the checked commit" >&2
    exit 1
fi
if [[ -n "${EXPECTED_RELEASE_SHA:-}" && "$head_sha" != "$EXPECTED_RELEASE_SHA" ]]; then
    echo "ERROR: tag $release_tag does not point to the Release Please output SHA" >&2
    exit 1
fi
if ! gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" >/dev/null; then
    echo "ERROR: expected GitHub Release $release_tag does not exist" >&2
    exit 1
fi

echo "tag_name=$release_tag" >>"$GITHUB_OUTPUT"
if [[ "$release_tag" == *rc* ]]; then
    echo "stable=false" >>"$GITHUB_OUTPUT"
else
    echo "stable=true" >>"$GITHUB_OUTPUT"
fi
