#!/usr/bin/env bash
# Checks on how the image is built, not on what runs in it.
#
# The publish build reuses cached layers (GitHub Actions cache and the
# registry's :latest image). The apk layer pins direct packages only, so with
# no pin changed it was reused, and transitive packages missed Alpine's
# security fixes: 2.11.0 shipped libexpat 2.8.5 (CVE-2026-77214) while 2.9.0
# was in the repo. A release now passes APK_REFRESH, unique per run, which the
# Dockerfile declares right before the apk layer; test builds pass nothing and
# keep their cache.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="build config"

DOCKERFILE="$REPO_ROOT/claude-terminal/Dockerfile"
PUBLISH="$REPO_ROOT/.github/workflows/publish.yml"
TEST_WORKFLOW="$REPO_ROOT/.github/workflows/test.yml"

# Only active instructions count: comment lines are dropped first, so a
# comment or a quoted string mentioning these names cannot satisfy a check.
active() { grep -v -E '^[[:space:]]*#' "$1"; }

# The instruction that follows `ARG APK_REFRESH` must be the apk layer itself,
# naming APK_REFRESH, so nothing cached sits in between.
after_arg=$(active "$DOCKERFILE" | awk '
    found && /^[[:space:]]*$/ { next }
    found { print; exit }
    /^ARG APK_REFRESH(=|$)/ { found = 1 }
')
# shellcheck disable=SC2016  # the literal Dockerfile text, not shell
assert_contains "the apk layer comes right after ARG APK_REFRESH and names it" \
    "$after_arg" 'RUN echo "apk refresh: ${APK_REFRESH:-none}"'
apk_layer=$(active "$DOCKERFILE" | awk '/^ARG APK_REFRESH(=|$)/ { found = 1; next } found && /^RUN / { on = 1 } on { print } on && !/\\$/ { exit }')
assert_contains "and that layer runs apk upgrade" "$apk_layer" '&& apk upgrade --no-cache'

# Declared before any other RUN, so the first RUN it invalidates is the apk one.
first_run=$(grep -n -m1 '^RUN ' "$DOCKERFILE" | cut -d: -f1)
arg_line=$(grep -n -m1 '^ARG APK_REFRESH' "$DOCKERFILE" | cut -d: -f1)
assert_eq "no RUN comes before APK_REFRESH" "1" "$([ -n "$arg_line" ] && [ "$arg_line" -lt "$first_run" ] && echo 1 || echo 0)"

# The release build passes a value unique to the run (a rerun gets a new one),
# as a line of the builder's build-args, not in a comment.
# shellcheck disable=SC2016  # a literal GitHub Actions expression, not shell
assert_eq "publish.yml passes APK_REFRESH unique to the run" "1" \
    "$(active "$PUBLISH" | grep -c -E '^[[:space:]]+APK_REFRESH=\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}$')"
assert_eq "under build-args" "1" "$(active "$PUBLISH" | grep -B1 -E '^[[:space:]]+APK_REFRESH=' | grep -c -E '^[[:space:]]+build-args: \|$')"

# Test builds must not pass it, or every CI build would miss the cache. A
# comment mentioning it is fine.
assert_not_contains "test.yml does not pass APK_REFRESH" "$(active "$TEST_WORKFLOW")" "APK_REFRESH"

finish_suite
