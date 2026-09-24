#!/usr/bin/env bash
# Unit tests for check_claude_cli in claude-terminal/scripts/health-check.sh —
# the check behind the user-facing `claude-doctor` command.
#
# health-check.sh guards its run_diagnostics call with a BASH_SOURCE check, so
# sourcing it here defines the functions without running the full diagnostic.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="health-check.sh"

# shellcheck source=claude-terminal/scripts/health-check.sh
. "$REPO_ROOT/claude-terminal/scripts/health-check.sh"

# Lay out a fixture mirroring the three real install locations under a
# relocatable prefix. Each argument names a location to populate:
#   packages  -> /data/packages/bin/claude   (first on the runtime PATH)
#   home      -> /data/home/.local/bin/claude (where `claude` actually resolves)
#   root      -> /root/.local/bin/claude      (bundled copy, not on PATH)
# Prefix a name with "broken:" to install a binary that exists and is +x but
# aborts on launch, the way a libc mismatch behaves.
setup_bins() {
    local root="$1"; shift
    rm -rf "${root:?}/data" "${root:?}/root"
    export CLAUDE_BIN_PREFIX="$root"
    local spec name
    for spec in "$@"; do
        case "$spec" in
            broken:*) name="${spec#broken:}" ;;
            *)        name="$spec" ;;
        esac
        local path
        case "$name" in
            packages) path="$root/data/packages/bin/claude" ;;
            home)     path="$root/data/home/.local/bin/claude" ;;
            root)     path="$root/root/.local/bin/claude" ;;
            *) printf 'setup_bins: unknown location %s\n' "$name" >&2; return 1 ;;
        esac
        case "$spec" in
            broken:*) make_stub "$path" 1 "" "Error relocating $path: posix_getdents: symbol not found" ;;
            *)        make_stub "$path" 0 "2.1.236 (Claude Code)" ;;
        esac
    done
}

fixture=$(new_tmpdir)

printf '\n%s\n' "check_claude_cli"

# --- the states a user can actually be in ----------------------------------

setup_bins "$fixture" home
assert_status "a working binary passes" 0 check_claude_cli
out=$(check_claude_cli 2>&1)
assert_contains "and reports the version it ran" "$out" "Claude CLI runs: 2.1.236 (Claude Code)"

setup_bins "$fixture" broken:home
assert_status "a present-but-unrunnable binary fails" 1 check_claude_cli
out=$(check_claude_cli 2>&1)
assert_contains "and says so explicitly" "$out" "present but fails to run"
assert_contains "and surfaces the real error" "$out" "Error relocating"

setup_bins "$fixture"
assert_status "no binary at all fails" 1 check_claude_cli
out=$(check_claude_cli 2>&1)
assert_contains "and points at the recovery" "$out" "Restart the add-on"

# --- probe order ------------------------------------------------------------
#
# The probe must follow the runtime PATH order run.sh exports. Checking the
# bundled /root copy first green-ticked a healthy binary while the persistent
# copy that `claude` actually launches was broken — reporting "all checks
# passed" for precisely the fault this command exists to find.

setup_bins "$fixture" broken:home root
assert_status "a broken persistent copy fails even when the bundled copy works" 1 check_claude_cli
out=$(check_claude_cli 2>&1)
assert_contains "and names the binary that actually runs" "$out" "/data/home/.local/bin/claude"
assert_not_contains "not the bundled fallback" "$out" "/root/.local/bin/claude"

setup_bins "$fixture" broken:packages home root
assert_status "/data/packages wins over both, matching PATH" 1 check_claude_cli
out=$(check_claude_cli 2>&1)
assert_contains "and names the /data/packages copy" "$out" "/data/packages/bin/claude"

setup_bins "$fixture" root
assert_status "the bundled copy is still used when it is all there is" 0 check_claude_cli
out=$(check_claude_cli 2>&1)
assert_contains "and is named as the one found" "$out" "/root/.local/bin/claude"

unset CLAUDE_BIN_PREFIX

# ---------------------------------------------------------------------------
# run_diagnostics
# ---------------------------------------------------------------------------
# The orchestrator behind claude-doctor and the startup health check. The
# individual checks are covered above; what matters here is that ONE failing
# check does not hide the rest. Every case runs under bashio's shell options,
# which is where that went wrong: `check || ((errors++))` evaluates to 0 when
# errors is 0, and errexit ended the script at the first failure - no later
# checks, no summary.
printf '\n%s\n' "run_diagnostics"

# Replace each check with a stub that records it ran and exits with the status
# named for it, so the orchestrator is tested on its own.
# shellcheck disable=SC2016  # expanded by the inner shell
diagnostics_snippet='
    . "$REPO_ROOT/claude-terminal/scripts/health-check.sh"
    calls="$1"; shift
    for spec in "$@"; do
        name="${spec%%=*}" status="${spec#*=}"
        eval "$name() { echo $name >> \"\$calls\"; return $status; }"
    done
    run_diagnostics
'

diag_dir=$(new_tmpdir)
all_checks="check_system_resources check_cpu_capabilities check_directory_permissions check_node_installation check_claude_cli"

rm -f "$diag_dir/calls"
assert_status "a clean run returns 0" 0 run_under_bashio "$diagnostics_snippet" "$diag_dir/calls" \
    check_system_resources=0 check_cpu_capabilities=0 check_directory_permissions=0 \
    check_node_installation=0 check_claude_cli=0

rm -f "$diag_dir/calls"
assert_status "returns the number of failed checks" 2 run_under_bashio "$diagnostics_snippet" "$diag_dir/calls" \
    check_system_resources=0 check_cpu_capabilities=1 check_directory_permissions=0 \
    check_node_installation=0 check_claude_cli=1
assert_eq "every check runs even after an early one fails" \
    "$all_checks" "$(tr '\n' ' ' < "$diag_dir/calls" | sed 's/ $//')"

# The summary is the one line a user reads. Keep the error stub audible for
# this case only.
# shellcheck disable=SC2016  # expanded by the inner shell
out=$(run_under_bashio 'bashio::log.error() { printf "%s\n" "$*" >&2; }
'"$diagnostics_snippet" "$diag_dir/calls" \
    check_system_resources=1 check_cpu_capabilities=0 check_directory_permissions=0 \
    check_node_installation=0 check_claude_cli=0 2>&1)
assert_contains "and still prints the summary" "$out" "1 check(s) failed"

finish_suite
