#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

context_script="$repo_root/scripts/ci/release-context.sh"
verify_script="$repo_root/scripts/ci/verify-release-artifact.sh"
upload_script="$repo_root/scripts/ci/upload-release-asset.sh"
publication_script="$repo_root/scripts/ci/check-container-publication.sh"
notes_script="$repo_root/scripts/ci/update-release-container-notes.sh"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

assert_line() {
    local expected=$1
    local output_file=$2
    grep -Fqx "$expected" "$output_file" || fail "missing output: $expected"
}

gh() {
    case "$1 ${2:-}" in
        "api "*)
            if [[ "$*" == *'/git/ref/heads/main'* ]]; then
                printf '%s\n' "$MOCK_MAIN_SHA"
            elif [[ "$*" == *'autorelease: pending'* ]]; then
                printf '%s' "${MOCK_PENDING_PR:-}"
            elif [[ "$*" == *'autorelease: tagged'* ]]; then
                printf '%s' "${MOCK_TAGGED_PR:-}"
            else
                fail "unexpected gh api call: $*"
            fi
            ;;
        "release view")
            [[ "${MOCK_RELEASE_EXISTS:-true}" == true ]] || return 1
            if [[ -n "${MOCK_RELEASE_BODY_FILE:-}" ]]; then
                cat "$MOCK_RELEASE_BODY_FILE"
            else
                printf '%s' "${MOCK_RELEASE_BODY:-}"
            fi
            ;;
        "release upload")
            printf '%s\n' "$*" >>"$MOCK_GH_LOG"
            ;;
        "release edit")
            local previous=
            local argument
            for argument in "$@"; do
                if [[ "$previous" == --notes-file ]]; then
                    cp "$argument" "$MOCK_RELEASE_BODY_FILE"
                    return
                fi
                previous=$argument
            done
            fail "gh release edit omitted --notes-file"
            ;;
        *)
            fail "unexpected gh call: $*"
            ;;
    esac
}
export -f gh fail

docker() {
    if [[ "${MOCK_INSPECT_RESULT:-success}" == success ]]; then
        printf '%s\n' "$MOCK_MANIFEST"
    else
        printf '%s\n' "$MOCK_INSPECT_ERROR" >&2
        return 1
    fi
}
export -f docker

sha=1111111111111111111111111111111111111111
other_sha=2222222222222222222222222222222222222222
context_output="$test_root/context-output"

run_context() {
    : >"$context_output"
    EXPECTED_SHA=$sha \
        GITHUB_REPOSITORY=jonocairns/obsidian-sync-mcp \
        GITHUB_OUTPUT=$context_output \
        MOCK_MAIN_SHA=${MOCK_MAIN_SHA:-$sha} \
        MOCK_PENDING_PR=${MOCK_PENDING_PR:-} \
        MOCK_TAGGED_PR=${MOCK_TAGGED_PR:-} \
        "$context_script" >/dev/null
}

MOCK_MAIN_SHA=$sha MOCK_PENDING_PR='' MOCK_TAGGED_PR='' run_context
assert_line 'update-pr=true' "$context_output"
assert_line 'create-release=false' "$context_output"
assert_line 'release-context=false' "$context_output"

MOCK_MAIN_SHA=$sha MOCK_PENDING_PR=42 MOCK_TAGGED_PR='' run_context
assert_line 'create-release=true' "$context_output"
assert_line 'release-context=true' "$context_output"

MOCK_MAIN_SHA=$sha MOCK_PENDING_PR='' MOCK_TAGGED_PR=42 run_context
assert_line 'create-release=false' "$context_output"
assert_line 'release-context=true' "$context_output"

MOCK_MAIN_SHA=$other_sha MOCK_PENDING_PR='' MOCK_TAGGED_PR='' run_context
assert_line 'update-pr=false' "$context_output"

if EXPECTED_SHA=invalid GITHUB_REPOSITORY=owner/repo GITHUB_OUTPUT="$context_output" \
    "$context_script" >/dev/null 2>&1; then
    fail 'release context accepted an invalid commit SHA'
fi

verify_repo="$test_root/verify"
mkdir -p "$verify_repo"
git -C "$verify_repo" init -q
git -C "$verify_repo" config user.name 'Release Test'
git -C "$verify_repo" config user.email release-test@example.com
printf '{"version":"0.8.2"}\n' >"$verify_repo/package.json"
git -C "$verify_repo" add package.json
git -C "$verify_repo" commit -qm 'fix: test release'
git -C "$verify_repo" tag v0.8.2
verify_sha=$(git -C "$verify_repo" rev-parse HEAD)
verify_output="$test_root/verify-output"

(
    cd "$verify_repo"
    GITHUB_REF=refs/tags/v0.8.2 \
        GITHUB_REF_NAME=v0.8.2 \
        GITHUB_REPOSITORY=owner/repo \
        GITHUB_OUTPUT=$verify_output \
        EXPECTED_RELEASE_SHA=$verify_sha \
        MOCK_RELEASE_EXISTS=true \
        "$verify_script" >/dev/null
)
assert_line 'tag_name=v0.8.2' "$verify_output"
assert_line 'stable=true' "$verify_output"

if (
    cd "$verify_repo"
    GITHUB_REF=refs/tags/v0.8.3 \
        GITHUB_REF_NAME=v0.8.3 \
        GITHUB_REPOSITORY=owner/repo \
        GITHUB_OUTPUT=$verify_output \
        MOCK_RELEASE_EXISTS=true \
        "$verify_script" >/dev/null 2>&1
); then
    fail 'release verification accepted a tag/package mismatch'
fi

printf '{"version":"0.9.0-rc.1"}\n' >"$verify_repo/package.json"
git -C "$verify_repo" add package.json
git -C "$verify_repo" commit -qm 'feat: test prerelease'
git -C "$verify_repo" tag v0.9.0-rc.1
: >"$verify_output"
(
    cd "$verify_repo"
    GITHUB_REF=refs/tags/v0.9.0-rc.1 \
        GITHUB_REF_NAME=v0.9.0-rc.1 \
        GITHUB_REPOSITORY=owner/repo \
        GITHUB_OUTPUT=$verify_output \
        MOCK_RELEASE_EXISTS=true \
        "$verify_script" >/dev/null
)
assert_line 'stable=false' "$verify_output"

upload_dir="$test_root/upload"
mkdir -p "$upload_dir"
touch "$upload_dir/obsidian-sync-mcp-0.8.2.tgz"
upload_log="$test_root/upload-log"
(
    cd "$upload_dir"
    GITHUB_REPOSITORY=owner/repo \
        MOCK_RELEASE_EXISTS=true \
        MOCK_GH_LOG=$upload_log \
        "$upload_script" v0.8.2
)
grep -Fq 'release upload v0.8.2 obsidian-sync-mcp-0.8.2.tgz --repo owner/repo --clobber' "$upload_log" \
    || fail 'release upload was not idempotent'
touch "$upload_dir/extra.tgz"
if (
    cd "$upload_dir"
    GITHUB_REPOSITORY=owner/repo MOCK_RELEASE_EXISTS=true MOCK_GH_LOG=$upload_log \
        "$upload_script" v0.8.2 >/dev/null 2>&1
); then
    fail 'release upload accepted multiple package archives'
fi

digest="sha256:$(printf 'a%.0s' {1..64})"
manifest=$(printf '{"digest":"%s","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}' "$digest")
publication_output="$test_root/publication-output"
image_ref="ghcr.io/owner/repo:v0.8.2@${digest}"

MOCK_RELEASE_BODY=$image_ref \
    MOCK_MANIFEST=$manifest \
    MOCK_INSPECT_RESULT=success \
    RELEASE_TAG=v0.8.2 \
    GITHUB_REPOSITORY=owner/repo \
    GITHUB_OUTPUT=$publication_output \
    "$publication_script" >/dev/null
assert_line 'publish=false' "$publication_output"
assert_line "digest=$digest" "$publication_output"
assert_line 'document=false' "$publication_output"

: >"$publication_output"
MOCK_RELEASE_BODY='' \
    MOCK_MANIFEST=$manifest \
    MOCK_INSPECT_RESULT=success \
    RELEASE_TAG=v0.8.2 \
    GITHUB_REPOSITORY=owner/repo \
    GITHUB_OUTPUT=$publication_output \
    "$publication_script" >/dev/null
assert_line 'publish=false' "$publication_output"
assert_line 'document=true' "$publication_output"

: >"$publication_output"
MOCK_INSPECT_RESULT=failure \
    MOCK_INSPECT_ERROR='manifest unknown' \
    RELEASE_TAG=v0.8.2 \
    GITHUB_REPOSITORY=owner/repo \
    GITHUB_OUTPUT=$publication_output \
    "$publication_script" >/dev/null
assert_line 'publish=true' "$publication_output"
assert_line 'document=true' "$publication_output"

if MOCK_INSPECT_RESULT=failure \
    MOCK_INSPECT_ERROR='registry authentication failed' \
    RELEASE_TAG=v0.8.2 \
    GITHUB_REPOSITORY=owner/repo \
    GITHUB_OUTPUT=$publication_output \
    "$publication_script" >/dev/null 2>&1; then
    fail 'container publication ignored an unexpected registry error'
fi

release_body_file="$test_root/release-body"
printf 'Existing notes\n' >"$release_body_file"
for _ in 1 2; do
    GITHUB_REPOSITORY=owner/repo \
        MOCK_RELEASE_EXISTS=true \
        MOCK_RELEASE_BODY_FILE=$release_body_file \
        "$notes_script" v0.8.2 "$digest" >/dev/null
done
[[ $(grep -Fc '<!-- container-image:start -->' "$release_body_file") == 1 ]] \
    || fail 'container note update duplicated its marker block'
grep -Fq "$image_ref" "$release_body_file" || fail 'container note update omitted the immutable reference'

echo 'Release script tests passed'
