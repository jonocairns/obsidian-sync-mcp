#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

if ! release_body=$(gh release view "$RELEASE_TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --json body \
    --jq '.body // ""'); then
    echo "ERROR: expected GitHub Release $RELEASE_TAG does not exist" >&2
    exit 1
fi

image_tag="ghcr.io/${GITHUB_REPOSITORY}:${RELEASE_TAG}"
inspect_error=$(mktemp)
trap 'rm -f "$inspect_error"' EXIT

if manifest_json=$(docker buildx imagetools inspect "$image_tag" \
    --format '{{json .Manifest}}' 2>"$inspect_error"); then
    # The JavaScript template literal is intentionally protected from Bash.
    # shellcheck disable=SC2016
    if ! existing_digest=$(node -e '
      const manifest = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const platforms = new Set((manifest.manifests || []).map(
        entry => `${entry.platform?.os}/${entry.platform?.architecture}`
      ));
      if (!platforms.has("linux/amd64") || !platforms.has("linux/arm64")) {
        throw new Error("version tag is not a linux/amd64 + linux/arm64 image index");
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(manifest.digest || "")) {
        throw new Error("registry returned an invalid image-index digest");
      }
      process.stdout.write(manifest.digest);
    ' <<<"$manifest_json"); then
        echo "ERROR: existing GHCR tag $image_tag is not the expected multi-architecture image" >&2
        exit 1
    fi

    echo "publish=false" >>"$GITHUB_OUTPUT"
    echo "digest=$existing_digest" >>"$GITHUB_OUTPUT"
    if grep -Fq "${image_tag}@${existing_digest}" <<<"$release_body"; then
        echo "document=false" >>"$GITHUB_OUTPUT"
        echo "Release already records the published multi-architecture image."
    else
        echo "document=true" >>"$GITHUB_OUTPUT"
        echo "Recovering release notes from existing GHCR digest $existing_digest."
    fi
elif grep -Eiq 'manifest unknown|name unknown|not found' "$inspect_error"; then
    echo "publish=true" >>"$GITHUB_OUTPUT"
    echo "document=true" >>"$GITHUB_OUTPUT"
else
    cat "$inspect_error" >&2
    echo "ERROR: could not determine whether GHCR tag $image_tag already exists" >&2
    exit 1
fi
