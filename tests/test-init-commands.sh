#!/usr/bin/env bash
# Unit tests for run_init_commands in claude-terminal/run.sh: the
# init_commands option, run once per start before the terminal opens.
#
# The function reads the list straight from options.json (bashio::config
# mangles lists), so each case writes a fixture options file and points
# ADDON_OPTIONS_FILE at it. INIT_COMMANDS_DIR stands in for /config.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="init_commands"

# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

work=$(new_tmpdir)
export INIT_COMMANDS_DIR="$work"
export ADDON_OPTIONS_FILE="$work/options.json"

# write_options <json> - the add-on options as the Supervisor stores them
write_options() {
    printf '%s\n' "$1" > "$ADDON_OPTIONS_FILE"
}

# ---------------------------------------------------------------------------
# Nothing configured
# ---------------------------------------------------------------------------
printf '\n%s\n' "nothing configured"

rm -f "$ADDON_OPTIONS_FILE"
assert_eq "no options file is a silent no-op" "" "$(run_init_commands 2>&1)"

write_options '{"auto_launch_claude": true}'
assert_eq "a missing option is a silent no-op" "" "$(run_init_commands 2>&1)"

write_options '{"init_commands": null}'
assert_eq "a null option is a silent no-op" "" "$(run_init_commands 2>&1)"

write_options '{"init_commands": []}'
assert_eq "an empty list is a silent no-op" "" "$(run_init_commands 2>&1)"

write_options '{"init_commands": "echo not-a-list"}'
assert_not_contains "a string instead of a list is not run" \
    "$(run_init_commands 2>&1)" "not-a-list"

# ---------------------------------------------------------------------------
# Running commands
# ---------------------------------------------------------------------------
printf '\n%s\n' "running commands"

write_options '{"init_commands": ["echo hello from init", "pwd"]}'
out=$(run_init_commands 2>&1)
assert_contains "announces how many commands run" "$out" "Running 2 init command(s)"
assert_contains "logs each command" "$out" "Running: echo hello from init"
assert_contains "logs the command's output" "$out" "[init] hello from init"
assert_contains "runs from the config directory" "$out" "[init] $work"

# Output must reach the log, never stdout: main() does not capture it, but a
# caller reading stdout would get the user's command output spliced in.
assert_eq "nothing reaches stdout" "" "$(run_init_commands 2>/dev/null)"

write_options '{"init_commands": ["printf no-newline"]}'
assert_contains "a last line without a newline is still logged" \
    "$(run_init_commands 2>&1)" "[init] no-newline"

# A command spanning several lines is one entry, not one command per line.
# shellcheck disable=SC2016  # expanded by the command's own shell
write_options '{"init_commands": ["for n in 1 2; do\n  echo \"n=$n\"\ndone"]}'
out=$(run_init_commands 2>&1)
assert_contains "a multi-line command runs as one script (1)" "$out" "[init] n=1"
assert_contains "a multi-line command runs as one script (2)" "$out" "[init] n=2"
assert_not_contains "a multi-line command is not split up" "$out" "Exited with status"

# ---------------------------------------------------------------------------
# Failures
# ---------------------------------------------------------------------------
printf '\n%s\n' "failures"

write_options '{"init_commands": ["echo before; exit 3", "echo after"]}'
out=$(run_init_commands 2>&1)
assert_contains "a failing command's output is still logged" "$out" "[init] before"
assert_contains "a failing command warns with its status" "$out" "WARNING:   Exited with status 3: echo before; exit 3"
assert_contains "the next command still runs" "$out" "[init] after"

# shellcheck disable=SC2016  # expanded by the command's own shell
write_options '{"init_commands": ["read -r line; echo \"read=[$line]\""]}'
assert_contains "stdin is empty, so a prompt cannot wait for input" \
    "$(echo typed | run_init_commands 2>&1)" "read=[]"

# bashio runs run.sh with errexit, nounset and pipefail. A failing command
# must not take startup down with it.
write_options '{"init_commands": ["false", "touch survived"]}'
rm -f "$work/survived"
# shellcheck disable=SC2016  # expanded by the command's own shell
assert_status "a failing command survives bashio's shell options" 0 run_under_bashio '
    command -v timeout >/dev/null || timeout() { shift; "$@"; }   # see lib.sh
    . "$REPO_ROOT/claude-terminal/run.sh"
    run_init_commands
'
assert_status "and the commands after it ran" 0 test -f "$work/survived"

# ---------------------------------------------------------------------------
# Timeouts and services
# ---------------------------------------------------------------------------
printf '\n%s\n' "timeouts and services"

# lib.sh shims timeout away on a Mac without one; there is nothing to test then.
if [ "$(type -t timeout)" = "function" ]; then
    printf '  skip no timeout(1) on this machine\n'
else
    write_options '{"init_commands": ["sleep 10", "echo next"]}'
    start=$SECONDS
    out=$(INIT_COMMAND_TIMEOUT=1 run_init_commands 2>&1)
    elapsed=$((SECONDS - start))
    assert_contains "a command past its timeout is stopped with a warning" \
        "$out" "Stopped after 1s (use 'nohup ... &' for services): sleep 10"
    assert_contains "the next command still runs after a timeout" "$out" "[init] next"
    assert_status "the timeout bounds the wait (${elapsed}s)" 0 test "$elapsed" -lt 5
fi

# A service backgrounded without redirecting its output keeps the command's
# stdout open. Read through a pipe, startup would wait for the service to
# exit; through a file it returns at once.
write_options '{"init_commands": ["sleep 30 & echo $! > service.pid; echo started"]}'
start=$SECONDS
out=$(run_init_commands 2>&1)
elapsed=$((SECONDS - start))
assert_contains "a backgrounded service starts" "$out" "[init] started"
assert_status "and does not hold startup (${elapsed}s)" 0 test "$elapsed" -lt 5
if [ -s "$work/service.pid" ]; then
    pid=$(cat "$work/service.pid")
    assert_status "and is still running afterwards" 0 kill -0 "$pid"
    kill "$pid" 2>/dev/null
fi

finish_suite
