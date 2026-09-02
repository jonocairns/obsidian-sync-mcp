#!/usr/bin/env bash
set -euo pipefail

command=${1:?usage: release-artifact.sh <detect|verify|upload> [tag]}

detect_release() {
    : "${EXPECTED_SHA:?EXPECTED_SHA must be set}"
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
    : "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

    if [[ "${RELEASE_CREATED:-}" == true ]]; then
        : "${RELEASE_TAG:?RELEASE_TAG must be set when a release was created}"
        : "${RELEASE_SHA:?RELEASE_SHA must be set when a release was created}"
        [[ "$RELEASE_SHA" == "$EXPECTED_SHA" ]] || {
            echo "ERROR: Release Please output SHA does not match this CI commit" >&2
            exit 1
        }
        {
            echo "release-context=true"
            echo "tag-name=$RELEASE_TAG"
            echo "release-sha=$RELEASE_SHA"
        } >>"$GITHUB_OUTPUT"
        return
    fi

    local package_version release_tag tag_sha
    package_version=$(node -p "require('./package.json').version")
    release_tag="v${package_version}"
    if ! git fetch --force --no-tags origin \
        "refs/tags/${release_tag}:refs/tags/${release_tag}" >/dev/null 2>&1; then
        echo "release-context=false" >>"$GITHUB_OUTPUT"
        return
    fi
    tag_sha=$(git rev-list -n 1 "$release_tag")
    if [[ "$tag_sha" != "$EXPECTED_SHA" ]] || \
        ! gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" >/dev/null; then
        echo "release-context=false" >>"$GITHUB_OUTPUT"
        return
    fi

    {
        echo "release-context=true"
        echo "tag-name=$release_tag"
        echo "release-sha=$tag_sha"
    } >>"$GITHUB_OUTPUT"
    echo "Recovering downstream work for existing release $release_tag."
}

verify_release() {
    : "${GITHUB_REF:?GITHUB_REF must be set}"
    : "${GITHUB_REF_NAME:?GITHUB_REF_NAME must be set}"
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
    : "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set}"

    local package_version release_tag head_sha tag_sha
    package_version=$(node -p "require('./package.json').version")
    if [[ "$GITHUB_REF" == refs/tags/v* ]]; then
        release_tag=$GITHUB_REF_NAME
    else
        release_tag="v${package_version}"
    fi
    [[ "$release_tag" == "v${package_version}" ]] || {
        echo "ERROR: tag $release_tag does not match package.json version $package_version" >&2
        exit 1
    }
    git rev-parse --verify --quiet "refs/tags/${release_tag}^{commit}" >/dev/null || {
        echo "ERROR: expected tag $release_tag does not exist" >&2
        exit 1
    }
    head_sha=$(git rev-parse HEAD)
    tag_sha=$(git rev-list -n 1 "$release_tag")
    [[ "$tag_sha" == "$head_sha" ]] || {
        echo "ERROR: tag $release_tag does not point to the checked commit" >&2
        exit 1
    }
    [[ -z "${EXPECTED_RELEASE_SHA:-}" || "$head_sha" == "$EXPECTED_RELEASE_SHA" ]] || {
        echo "ERROR: tag $release_tag does not point to the Release Please output SHA" >&2
        exit 1
    }
    gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" >/dev/null || {
        echo "ERROR: expected GitHub Release $release_tag does not exist" >&2
        exit 1
    }
    echo "tag_name=$release_tag" >>"$GITHUB_OUTPUT"
    [[ "$release_tag" == *rc* ]] && echo "stable=false" >>"$GITHUB_OUTPUT" || echo "stable=true" >>"$GITHUB_OUTPUT"
}

upload_release() {
    local release_tag=${1:?usage: release-artifact.sh upload <tag>}
    : "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
    gh release view "$release_tag" --repo "$GITHUB_REPOSITORY" >/dev/null || {
        echo "ERROR: expected GitHub Release $release_tag does not exist" >&2
        exit 1
    }
    shopt -s nullglob
    local packages=(*.tgz)
    (( ${#packages[@]} == 1 )) || {
        echo "ERROR: expected exactly one .tgz package, found ${#packages[@]}" >&2
        exit 1
    }
    gh release upload "$release_tag" "${packages[0]}" --repo "$GITHUB_REPOSITORY" --clobber
}

case "$command" in
    detect) detect_release ;;
    verify) verify_release ;;
    upload) upload_release "${2:-}" ;;
    *) echo "ERROR: unknown command: $command" >&2; exit 1 ;;
esac
