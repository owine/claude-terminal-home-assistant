#!/usr/bin/env bash
# Shared helpers for the shell test suite.
#
# The scripts under test are add-on startup code: they run under
# `#!/usr/bin/with-contenv bashio` inside the container, talk to the Supervisor
# API, and touch /data. None of that is available in CI, so each test sources
# the script under test with bashio stubbed and points it at a temporary
# directory tree.
#
# Source this file, not execute it.

# ---------------------------------------------------------------------------
# bashio stubs
# ---------------------------------------------------------------------------

# Real bashio writes log output to $LOG_FD, NOT to stdout. That distinction is
# load-bearing: helpers like get_working_directory return their result on
# stdout via command substitution, and a log line leaking onto stdout would
# corrupt the returned value. Stubbing the log functions to stdout would make
# such a bug invisible here while the real thing worked - and the reverse is
# worse. Mirror bashio and send log output to stderr.
bashio::log.info()    { printf 'INFO: %s\n'    "$*" >&2; }
bashio::log.warning() { printf 'WARNING: %s\n' "$*" >&2; }
bashio::log.error()   { printf 'ERROR: %s\n'   "$*" >&2; }
bashio::log.debug()   { printf 'DEBUG: %s\n'   "$*" >&2; }

# bashio::config <key> [default] - reads whatever set_config recorded for the
# key. An unset key yields the default, matching how bashio behaves when an
# option is absent.
#
# Values are held in individual TEST_CONFIG_<key> variables rather than one
# associative array: `declare -A` needs bash 4, and macOS still ships bash 3.2
# as /bin/bash. Depending on bash 4 here would make the suite silently
# misbehave for anyone running it locally on a Mac - subscripts on a plain
# indexed array are evaluated arithmetically, so every key collapses to index
# 0 and the last value written wins for every lookup.
TEST_CONFIG_KEYS=""

# Config keys are add-on option names: lowercase, digits and underscores.
# Anything else would not round-trip through a variable name, so reject it
# loudly rather than silently reading the wrong key.
set_config() {
    # shellcheck disable=SC2034  # value is consumed by the eval below
    local key="$1" value="$2"
    case "$key" in
        *[!a-z0-9_]*|"")
            printf 'set_config: unusable key: %s\n' "$key" >&2
            return 1
            ;;
    esac
    eval "TEST_CONFIG_${key}=\$value"
    TEST_CONFIG_KEYS="$TEST_CONFIG_KEYS $key"
}

bashio::config() {
    local key="$1" default="${2:-}" var="TEST_CONFIG_$1"
    if [ -n "${!var+set}" ]; then
        printf '%s\n' "${!var}"
    else
        printf '%s\n' "$default"
    fi
}

# Reset config between tests so state cannot leak from one case to the next.
reset_config() {
    local key
    for key in $TEST_CONFIG_KEYS; do
        unset "TEST_CONFIG_${key}"
    done
    TEST_CONFIG_KEYS=""
}

# ---------------------------------------------------------------------------
# Portability shims
# ---------------------------------------------------------------------------

# check_claude_cli guards its runnability probe with `timeout`, which Alpine
# always provides via busybox. macOS does not ship one at all (GNU coreutils'
# is available as `gtimeout`, or as `timeout` only if coreutils is on PATH), so
# on a stock Mac the probe would fail with status 127 and report a healthy
# fixture binary as broken - a suite failure that says nothing about the code.
#
# Define a shim only when no real timeout exists. It ignores the duration and
# runs the command directly, which is correct for test fixtures: every stub
# under test exits immediately. The production path is unaffected, and the
# container's busybox timeout is used whenever it is present.
if ! command -v timeout >/dev/null 2>&1; then
    timeout() {
        shift          # discard the duration
        "$@"
    }
fi

# ---------------------------------------------------------------------------
# Production shell semantics
# ---------------------------------------------------------------------------

# bashio turns on four shell options for every script it runs
# (/usr/lib/bashio/bashio: errexit, errtrace, nounset, pipefail). The suites
# themselves run with them off so one failed assertion reports instead of
# aborting the run - which means a helper called directly here runs under
# looser rules than it does in the container. `((errors++))` passes here and
# kills health-check.sh there.
#
# Any case asserting a helper survives production semantics goes through this,
# rather than a hand-written `set -e` that covers one option of the four.
#
#   run_under_bashio <snippet> [args...]
#
# Bash version matters as much as the options. macOS ships bash 3.2, whose
# errexit does not fire on a failing `(( ))` at the end of an || list; bash 5
# (the container, and CI's runners) does. A case written for that bug passes on
# a stock Mac against the broken code - run the suite in the add-on image to
# see it fail (tests/README.md).
#
# Runs <snippet> in a fresh bash with bashio's options and silent log stubs.
# Positional args are passed through ($1...); REPO_ROOT is exported by this
# file, so snippets can source the script under test from it.
BASHIO_SHELL_OPTIONS='set -o errexit -o errtrace -o nounset -o pipefail'

run_under_bashio() {
    local snippet="$1"
    shift
    bash -c "$BASHIO_SHELL_OPTIONS
bashio::log.info()    { :; }
bashio::log.warning() { :; }
bashio::log.error()   { :; }
bashio::log.debug()   { :; }
$snippet" _ "$@"
}

# ---------------------------------------------------------------------------
# Assertions
# ---------------------------------------------------------------------------

TESTS_RUN=0
TESTS_FAILED=0
CURRENT_SUITE="${CURRENT_SUITE:-suite}"

_pass() {
    TESTS_RUN=$((TESTS_RUN + 1))
    printf '  ok   %s\n' "$1"
}

_fail() {
    TESTS_RUN=$((TESTS_RUN + 1))
    TESTS_FAILED=$((TESTS_FAILED + 1))
    printf '  FAIL %s\n' "$1"
    shift
    local line
    for line in "$@"; do
        printf '       %s\n' "$line"
    done
}

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        _pass "$desc"
    else
        _fail "$desc" "expected: [$expected]" "actual:   [$actual]"
    fi
}

assert_contains() {
    local desc="$1" haystack="$2" needle="$3"
    case "$haystack" in
        *"$needle"*) _pass "$desc" ;;
        *) _fail "$desc" "expected to contain: [$needle]" "actual: [$haystack]" ;;
    esac
}

assert_not_contains() {
    local desc="$1" haystack="$2" needle="$3"
    case "$haystack" in
        *"$needle"*) _fail "$desc" "expected NOT to contain: [$needle]" "actual: [$haystack]" ;;
        *) _pass "$desc" ;;
    esac
}

# assert_status <desc> <expected status> <command...>
assert_status() {
    local desc="$1" expected="$2"
    shift 2
    local actual=0
    "$@" >/dev/null 2>&1 || actual=$?
    if [ "$expected" = "$actual" ]; then
        _pass "$desc"
    else
        _fail "$desc" "expected exit status: $expected" "actual exit status:   $actual"
    fi
}

# Print the suite result and exit non-zero if anything failed.
finish_suite() {
    printf '%s: %d passed, %d failed\n' \
        "$CURRENT_SUITE" "$((TESTS_RUN - TESTS_FAILED))" "$TESTS_FAILED"
    [ "$TESTS_FAILED" -eq 0 ]
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# shellcheck disable=SC1007  # clearing CDPATH for this cd is deliberate
REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export REPO_ROOT

# Create a throwaway directory that is removed when the suite exits.
#
# Every directory lives under one root made here, in the sourcing shell. Suites
# call this as `dir=$(new_tmpdir)`, and command substitution runs it in a
# subshell: recording each directory in an array - as this used to - lost the
# record before the EXIT trap read it, and every run leaked its fixtures into
# $TMPDIR. Removing the root needs no record at all.
TEST_TMP_ROOT=$(mktemp -d)

new_tmpdir() {
    mktemp -d "$TEST_TMP_ROOT/t.XXXXXX"
}

cleanup_tmpdirs() {
    rm -rf "$TEST_TMP_ROOT"
    mkdir -p "$TEST_TMP_ROOT"
}
trap 'rm -rf "$TEST_TMP_ROOT"' EXIT

# Write an executable stub script.
#   make_stub <path> <exit status> [stdout text] [stderr text]
make_stub() {
    local path="$1" status="${2:-0}" out="${3:-}" err="${4:-}"
    mkdir -p "$(dirname -- "$path")"
    {
        printf '#!/bin/sh\n'
        [ -n "$out" ] && printf 'echo %s\n' "$(printf '%q' "$out")"
        [ -n "$err" ] && printf 'echo %s >&2\n' "$(printf '%q' "$err")"
        printf 'exit %s\n' "$status"
    } > "$path"
    chmod +x "$path"
}
