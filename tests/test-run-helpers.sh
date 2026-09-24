#!/usr/bin/env bash
# Unit tests for the pure helper functions in claude-terminal/run.sh.
#
# run.sh guards its `main` call with a BASH_SOURCE check, so sourcing it here
# defines the functions without starting the add-on.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="run.sh helpers"

# run.sh sets `set -e` and `set -o pipefail` at the top level, which the
# sourcing shell inherits. Turn errexit back off for the test driver so an
# assertion failure reports instead of aborting the suite; individual cases
# that care about errexit re-enable it in a subshell.
# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

# ---------------------------------------------------------------------------
# get_working_directory
# ---------------------------------------------------------------------------
printf '\n%s\n' "get_working_directory"

reset_config
assert_eq "unset falls back to /config" "/config" "$(get_working_directory 2>/dev/null)"

reset_config
set_config working_directory ""
assert_eq "empty falls back to /config" "/config" "$(get_working_directory 2>/dev/null)"

reset_config
set_config working_directory "null"
assert_eq "the string null falls back to /config" "/config" "$(get_working_directory 2>/dev/null)"

reset_config
existing=$(new_tmpdir)
set_config working_directory "$existing"
assert_eq "an existing directory is used" "$existing" "$(get_working_directory 2>/dev/null)"

reset_config
set_config working_directory "/nope/definitely-not-here"
assert_eq "a missing directory falls back to /config" "/config" "$(get_working_directory 2>/dev/null)"

# The fallback warning must not reach stdout. get_working_directory's result is
# consumed via command substitution, so a log line on stdout would be spliced
# into the returned path and tmux would be handed a nonsense directory.
reset_config
set_config working_directory "/nope/definitely-not-here"
captured=$(get_working_directory 2>/dev/null)
assert_not_contains "the fallback warning stays off stdout" "$captured" "does not exist"
warned=$(get_working_directory 2>&1 >/dev/null)
assert_contains "the fallback warning is still emitted on stderr" "$warned" "does not exist"

# ---------------------------------------------------------------------------
# export_oauth_token
# ---------------------------------------------------------------------------
printf '\n%s\n' "export_oauth_token"

reset_config
unset CLAUDE_CODE_OAUTH_TOKEN
export_oauth_token 2>/dev/null
assert_eq "unset exports nothing" "" "${CLAUDE_CODE_OAUTH_TOKEN:-}"

reset_config
set_config claude_code_oauth_token "null"
unset CLAUDE_CODE_OAUTH_TOKEN
export_oauth_token 2>/dev/null
assert_eq "the string null exports nothing" "" "${CLAUDE_CODE_OAUTH_TOKEN:-}"

reset_config
set_config claude_code_oauth_token "sk-ant-oat-TESTSECRET"
unset CLAUDE_CODE_OAUTH_TOKEN
export_oauth_token 2>/dev/null
assert_eq "a configured token is exported" "sk-ant-oat-TESTSECRET" "${CLAUDE_CODE_OAUTH_TOKEN:-}"

# The token is a long-lived credential. It must never be written to the add-on
# log, which users routinely paste into support threads.
reset_config
set_config claude_code_oauth_token "sk-ant-oat-TESTSECRET"
unset CLAUDE_CODE_OAUTH_TOKEN
logged=$(export_oauth_token 2>&1)
assert_not_contains "the token never reaches the log" "$logged" "TESTSECRET"
assert_contains "but the log records that one was set" "$logged" "CLAUDE_CODE_OAUTH_TOKEN set"
unset CLAUDE_CODE_OAUTH_TOKEN

# ---------------------------------------------------------------------------
# prune_claude_versions
# ---------------------------------------------------------------------------
printf '\n%s\n' "prune_claude_versions"

# Build a versions/ tree. Entries are given oldest-to-newest so that mtime
# ordering (which the function uses to find the newest) is deterministic.
setup_versions() {
    local root="$1"; shift
    local v stamp=1
    export XDG_DATA_HOME="$root/data"
    export HOME="$root/home"
    rm -rf "$XDG_DATA_HOME/claude" "$HOME/.local/bin"
    mkdir -p "$XDG_DATA_HOME/claude/versions" "$HOME/.local/bin"
    for v in "$@"; do
        mkdir -p "$XDG_DATA_HOME/claude/versions/$v"
        touch -t "260101000${stamp}" "$XDG_DATA_HOME/claude/versions/$v"
        stamp=$((stamp + 1))
    done
}

survivors() {
    # shellcheck disable=SC2012  # controlled semver names, no odd characters
    ls -1 "$XDG_DATA_HOME/claude/versions" 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//'
}

root=$(new_tmpdir)

# A launcher symlinked at an older version: that version AND the newest must
# both survive, so a rollback target is always available.
setup_versions "$root" 2.1.100 2.1.200 2.1.236 2.1.240
ln -sf "$XDG_DATA_HOME/claude/versions/2.1.200" "$HOME/.local/bin/claude"
prune_claude_versions 2>/dev/null
assert_eq "symlinked launcher: active and newest survive" "2.1.200 2.1.240" "$(survivors)"

# Our Dockerfile installs a plain copy rather than a symlink into versions/,
# so readlink resolves to the file itself and matches no entry. Only the
# newest-entry guard applies.
setup_versions "$root" 2.1.100 2.1.200 2.1.240
printf '#!/bin/sh\n' > "$HOME/.local/bin/claude"
chmod +x "$HOME/.local/bin/claude"
prune_claude_versions 2>/dev/null
assert_eq "plain copied launcher: newest survives" "2.1.240" "$(survivors)"

setup_versions "$root" 2.1.100 2.1.240
prune_claude_versions 2>/dev/null
assert_eq "absent launcher: newest survives" "2.1.240" "$(survivors)"

setup_versions "$root" 2.1.240
prune_claude_versions 2>/dev/null
assert_eq "a single version is never pruned" "2.1.240" "$(survivors)"

setup_versions "$root"
assert_status "an empty versions dir succeeds" 0 prune_claude_versions
assert_eq "an empty versions dir stays empty" "" "$(survivors)"

setup_versions "$root" 2.1.240
rm -rf "$XDG_DATA_HOME/claude"
assert_status "a missing versions dir succeeds" 0 prune_claude_versions

# Pruning is idempotent: a second pass over an already-pruned tree changes
# nothing and still succeeds.
setup_versions "$root" 2.1.100 2.1.200 2.1.240
prune_claude_versions 2>/dev/null
first=$(survivors)
prune_claude_versions 2>/dev/null
assert_eq "pruning is idempotent" "$first" "$(survivors)"

# init_environment runs under bashio's errexit. The guard clauses inside the
# prune loop are AND-lists whose test can legitimately fail, and errexit must
# not treat that as fatal.
setup_versions "$root" 2.1.100 2.1.200 2.1.240
ln -sf "$XDG_DATA_HOME/claude/versions/2.1.100" "$HOME/.local/bin/claude"
# shellcheck disable=SC2016  # $REPO_ROOT is expanded by the inner shell
assert_status "survives bashio's shell options" 0 run_under_bashio '
    . "$REPO_ROOT/claude-terminal/run.sh"
    prune_claude_versions
'

# ---------------------------------------------------------------------------
# supervise
# ---------------------------------------------------------------------------
# Keeps the wrapper alive. Nothing else restarts it: config.yaml has no
# watchdog, and ttyd keeps the container "running" without it, so a dead
# wrapper meant a 502 on ingress until someone restarted the add-on by hand.
#
# Every case runs under `set -Eeuo pipefail`, which is what bashio applies in
# production. A restart loop is exactly the code errexit breaks: the supervised
# command failing is the normal case, not the exceptional one.
printf '\n%s\n' "supervise"

sup_dir=$(new_tmpdir)
# Record each back-off delay instead of sleeping through it.
sleep() { printf '%s ' "$1" >> "$sup_dir/delays"; }
runs() { cat "$sup_dir/runs" 2>/dev/null | wc -l | tr -d ' '; }
reset_supervise() { rm -f "$sup_dir/runs" "$sup_dir/delays"; }

exits_ok()   { echo run >> "$sup_dir/runs"; return 0; }
exits_fail() { echo run >> "$sup_dir/runs"; return 7; }
# A pipeline whose first stage fails - the shape of the real wrapper command,
# `node ... | while read ...`. Under pipefail this returns node's status.
pipeline_fail() { echo run >> "$sup_dir/runs"; false | cat; }

reset_supervise
( set -Eeuo pipefail; SUPERVISE_MAX_RUNS=3 supervise test exits_ok ) 2>/dev/null
assert_eq "restarts a command that exits cleanly" "3" "$(runs)"

reset_supervise
( set -Eeuo pipefail; SUPERVISE_MAX_RUNS=3 supervise test exits_fail ) 2>/dev/null
assert_eq "restarts a command that fails, under errexit" "3" "$(runs)"

reset_supervise
( set -Eeuo pipefail; SUPERVISE_MAX_RUNS=3 supervise test pipeline_fail ) 2>/dev/null
assert_eq "restarts a failing pipeline, under pipefail" "3" "$(runs)"

reset_supervise
log=$( ( set -Eeuo pipefail; SUPERVISE_MAX_RUNS=1 supervise Wrapper exits_fail ) 2>&1 >/dev/null)
assert_contains "logs which service exited and with what status" "$log" "Wrapper exited (status 7)"

reset_supervise
( set -Eeuo pipefail; SUPERVISE_MAX_RUNS=7 supervise test exits_fail ) 2>/dev/null
assert_eq "backs off exponentially, capped at 30s" "1 2 4 8 16 30 " "$(cat "$sup_dir/delays")"

# A crash after a long healthy run is not a crash loop; it should come back
# quickly rather than inheriting the back-off of some earlier burst.
reset_supervise
long_on_third() {
    echo run >> "$sup_dir/runs"
    [ "$(runs)" -eq 3 ] && SECONDS=$((SECONDS + 120))
    return 1
}
( set -Eeuo pipefail; SUPERVISE_MAX_RUNS=4 supervise test long_on_third ) 2>/dev/null
assert_eq "resets the back-off after a run that stayed up" "1 2 1 " "$(cat "$sup_dir/delays")"

# ---------------------------------------------------------------------------
# wait_for_http
# ---------------------------------------------------------------------------
# Replaces a `kill -0` on the backgrounded pipeline, which only ever proved the
# `while read` loop was alive - never node - and now that the wrapper runs under
# supervise() would prove nothing at all.
printf '\n%s\n' "wait_for_http"

curl_calls="$sup_dir/curl_calls"
curl_ok_on_third() {
    echo call >> "$curl_calls"
    [ "$(wc -l < "$curl_calls" | tr -d ' ')" -ge 3 ]
}

rm -f "$curl_calls"
# shellcheck disable=SC2329  # invoked by wait_for_http
curl() { curl_ok_on_third; }
assert_status "succeeds once the endpoint answers" 0 wait_for_http http://127.0.0.1:7680/health 5
assert_eq "stops polling once it has answered" "3" "$(wc -l < "$curl_calls" | tr -d ' ')"

# shellcheck disable=SC2329  # invoked by wait_for_http
curl() { return 7; }
assert_status "fails when the endpoint never answers" 1 wait_for_http http://127.0.0.1:7680/health 3

unset -f curl sleep

finish_suite
