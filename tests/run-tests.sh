#!/usr/bin/env bash
# Run the shell test suite.
#
#   tests/run-tests.sh            run every suite
#   tests/run-tests.sh health     run only suites whose filename matches "health"
#
# Each tests/test-*.sh is a standalone suite: it sources lib.sh, sources the
# script under test with bashio stubbed, and exits non-zero if any assertion
# failed. Suites run in separate shells so one cannot leak state into another.

set -u

cd -- "$(dirname -- "$0")" || exit 1

filter="${1:-}"
failed=0
ran=0

for suite in test-*.sh; do
    [ -e "$suite" ] || continue
    case "$suite" in
        *"$filter"*) ;;
        *) continue ;;
    esac

    ran=$((ran + 1))
    printf '\n=== %s ===\n' "$suite"
    if ! bash "$suite"; then
        failed=$((failed + 1))
    fi
done

printf '\n'
if [ "$ran" -eq 0 ]; then
    printf 'No suites matched "%s"\n' "$filter" >&2
    exit 1
fi

if [ "$failed" -ne 0 ]; then
    printf '%d of %d suite(s) FAILED\n' "$failed" "$ran" >&2
    exit 1
fi

printf 'All %d suite(s) passed\n' "$ran"
