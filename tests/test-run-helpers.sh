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
# install_bundled_claude
# ---------------------------------------------------------------------------
printf '\n%s\n' "install_bundled_claude"

bundled_dir=$(new_tmpdir)
export CLAUDE_BUNDLED_BIN="$bundled_dir/claude"
printf 'image-binary\n' > "$CLAUDE_BUNDLED_BIN"

home_dir=$(new_tmpdir)
install_bundled_claude "$home_dir" 2>/dev/null
assert_eq "a fresh home gets a copy of the image's binary" \
    "image-binary" "$(cat "$home_dir/.local/bin/claude" 2>/dev/null)"
assert_eq "the copy is executable" "yes" \
    "$([ -x "$home_dir/.local/bin/claude" ] && echo yes || echo no)"

home_dir=$(new_tmpdir)
mkdir -p "$home_dir/.local/bin" "$home_dir/versions"
printf 'self-updated\n' > "$home_dir/versions/2.9.0"
ln -s "$home_dir/versions/2.9.0" "$home_dir/.local/bin/claude"
install_bundled_claude "$home_dir" 2>/dev/null
assert_eq "a launcher symlinked to a live version is left alone" \
    "self-updated" "$(cat "$home_dir/.local/bin/claude")"

home_dir=$(new_tmpdir)
mkdir -p "$home_dir/.local/bin"
printf 'older-copy\n' > "$home_dir/.local/bin/claude"
install_bundled_claude "$home_dir" 2>/dev/null
assert_eq "an existing copied launcher is not overwritten by the image's" \
    "older-copy" "$(cat "$home_dir/.local/bin/claude")"

# versions/ removed by hand, leaving the launcher dangling. Not reachable
# through a restore - a backup holds both paths or neither - but GNU cp (on
# PATH when coreutils is persisted) fails on such a link, as does the BSD cp
# these tests may run under; BusyBox cp happens to cope.
home_dir=$(new_tmpdir)
mkdir -p "$home_dir/.local/bin"
ln -s "$home_dir/versions/2.9.0" "$home_dir/.local/bin/claude"
(set -e; install_bundled_claude "$home_dir" 2>/dev/null)
assert_eq "a dangling launcher does not abort startup under set -e" "0" "$?"
assert_eq "a dangling launcher is replaced by the image's binary" \
    "image-binary" "$(cat "$home_dir/.local/bin/claude" 2>/dev/null)"
assert_eq "and the replacement is a regular file, not a link" "no" \
    "$([ -L "$home_dir/.local/bin/claude" ] && echo yes || echo no)"

home_dir=$(new_tmpdir)
CLAUDE_BUNDLED_BIN="$bundled_dir/missing" install_bundled_claude "$home_dir" 2>/dev/null
assert_eq "no image binary, nothing installed" "no" \
    "$([ -e "$home_dir/.local/bin/claude" ] && echo yes || echo no)"
unset CLAUDE_BUNDLED_BIN

# ---------------------------------------------------------------------------
# export_login_notification
# ---------------------------------------------------------------------------
printf '\n%s\n' "export_login_notification"

reset_config
unset LOGIN_NOTIFICATION
export_login_notification 2>/dev/null
assert_eq "unset defaults to on" "true" "${LOGIN_NOTIFICATION:-}"

reset_config
set_config login_notification "null"
unset LOGIN_NOTIFICATION
export_login_notification 2>/dev/null
assert_eq "the string null stays on" "true" "${LOGIN_NOTIFICATION:-}"

reset_config
set_config login_notification "true"
unset LOGIN_NOTIFICATION
export_login_notification 2>/dev/null
assert_eq "true is exported as true" "true" "${LOGIN_NOTIFICATION:-}"

reset_config
set_config login_notification "false"
unset LOGIN_NOTIFICATION
export_login_notification 2>/dev/null
assert_eq "false is exported as false" "false" "${LOGIN_NOTIFICATION:-}"
logged=$(export_login_notification 2>&1)
assert_contains "turning it off is logged" "$logged" "disabled"
unset LOGIN_NOTIFICATION

# ---------------------------------------------------------------------------
# export_upload_max_mb
# ---------------------------------------------------------------------------
# Passed to the wrapper as read; the wrapper owns the fallback to 25
# (files-upload.js, uploadMaxBytes), so an unreadable value must arrive as
# the empty string, not as a guess.
printf '\n%s\n' "export_upload_max_mb"

reset_config
unset UPLOAD_MAX_MB
export_upload_max_mb 2>/dev/null
assert_eq "unset defaults to 25" "25" "${UPLOAD_MAX_MB:-}"

reset_config
set_config upload_max_mb "100"
export_upload_max_mb 2>/dev/null
assert_eq "a set value is exported" "100" "${UPLOAD_MAX_MB:-}"
assert_eq "and reaches a child process" "100" "$(bash -c 'printf %s "$UPLOAD_MAX_MB"')"

reset_config
set_config upload_max_mb ""
export_upload_max_mb 2>/dev/null
assert_eq "an unreadable value is passed on empty" "set:" "${UPLOAD_MAX_MB+set}:${UPLOAD_MAX_MB:-}"
unset UPLOAD_MAX_MB
reset_config

# The schema is the cap: the Supervisor refuses to save a bigger value, so
# the wrapper never sees one (its own parse of up to 7 digits stays as
# defence). DOCS.md's options table states the same maximum.
assert_eq "config.yaml's schema caps upload_max_mb at 1024 MB" "  upload_max_mb: int(1,1024)?" \
    "$(grep -E '^  upload_max_mb: int' "$REPO_ROOT/claude-terminal/config.yaml")"
# shellcheck disable=SC2016  # the backticks are Markdown, matched literally
assert_contains "DOCS.md states the 1024 MB maximum" \
    "$(grep -E '^\| `upload_max_mb`' "$REPO_ROOT/claude-terminal/DOCS.md")" "1024"

# upload_retention_days likewise: prune_old_files (run.sh) finds files older
# than $((days * 1440)) minutes, and shell arithmetic wraps past 2^63, so an
# unbounded value could come out small or negative and sweep the inbox.
# 36500 days (100 years) is far from that.
assert_eq "config.yaml's schema caps upload_retention_days at 36500 days" "  upload_retention_days: int(0,36500)?" \
    "$(grep -E '^  upload_retention_days: int' "$REPO_ROOT/claude-terminal/config.yaml")"
# shellcheck disable=SC2016  # the backticks are Markdown, matched literally
assert_contains "DOCS.md states the 36500-day maximum" \
    "$(grep -E '^\| `upload_retention_days`' "$REPO_ROOT/claude-terminal/DOCS.md")" "36500"

# ---------------------------------------------------------------------------
# prune_old_files: a retention period too large to count in minutes
# ---------------------------------------------------------------------------
# find is given $((days * 1440)) minutes, and shell arithmetic wraps past 2^63
# without a word. 12810238940076078 days times 1440 is 2^64 + 704, so it came
# out as 704 minutes and swept every file older than half a day.
# 18459554312649627694 is that number plus 2^64: the shell's own parse wraps
# it to the same value, and `[` cannot read it at all. The schema caps
# upload_retention_days, but image_retention_days is int(0,)? and existing
# installs must keep validating, so prune_old_files refuses anything over
# 36500 days itself.
printf '\n%s\n' "prune_old_files: oversized retention"

# A folder holding one file last modified in 2020.
aged_folder() {
    local dir
    dir=$(new_tmpdir)
    touch -t 202001010000 "$dir/old.txt"
    printf '%s\n' "$dir"
}
kept() { [ -e "$1/old.txt" ] && echo yes || echo no; }

for huge in 12810238940076078 18459554312649627694; do
    reset_config
    dir=$(aged_folder)
    set_config image_retention_days "$huge"
    out=$(prune_old_files "$dir" image_retention_days '*' "test files" 2>&1 >/dev/null)
    assert_eq "a ${#huge}-digit retention deletes nothing" "yes" "$(kept "$dir")"
    assert_contains "and says it keeps them all (${#huge} digits)" "$out" "more than 36500 days (${huge}); keeping all test files"
done

reset_config
dir=$(aged_folder)
set_config image_retention_days 36501
out=$(prune_old_files "$dir" image_retention_days '*' "test files" 2>&1 >/dev/null)
assert_contains "36501 days, one past the cap, keeps all too" "$out" "keeping all test files"

reset_config
dir=$(aged_folder)
set_config image_retention_days 36500
out=$(prune_old_files "$dir" image_retention_days '*' "test files" 2>&1 >/dev/null)
assert_not_contains "36500 days, the cap itself, is accepted" "$out" "keeping all"

reset_config
dir=$(aged_folder)
set_config image_retention_days 30
prune_old_files "$dir" image_retention_days '*' "test files" 2>/dev/null
assert_eq "an ordinary retention still prunes" "no" "$(kept "$dir")"

# bashio logs to LOG_FD, never stdout; the stub logs to stderr likewise.
reset_config
set_config image_retention_days 18459554312649627694
assert_eq "the refusal writes nothing to stdout" "" \
    "$(prune_old_files "$(aged_folder)" image_retention_days '*' "test files" 2>/dev/null)"
reset_config

# Under bashio's options, inherit_errexit included: a 20-digit value is not a
# number to `[`, and the guard must neither abort startup nor fall through.
dir=$(aged_folder)
# shellcheck disable=SC2016  # expanded by the inner shell
assert_status "survives bashio's shell options, and still deletes nothing" 0 run_under_bashio '
    shopt -s inherit_errexit 2>/dev/null || true
    bashio::config() { printf "%s\n" 18459554312649627694; }
    . "$REPO_ROOT/claude-terminal/run.sh"
    prune_old_files "$1" image_retention_days "*" "test files"
    [ -e "$1/old.txt" ]
' "$dir"

# shellcheck disable=SC2016  # the backticks are Markdown, matched literally
assert_contains "DOCS.md says a retention over 36500 days keeps everything" \
    "$(grep -E '^\| `image_retention_days`' "$REPO_ROOT/claude-terminal/DOCS.md")" "over 36500"

# ---------------------------------------------------------------------------
# prune_upload_inbox: only an inbox the add-on made
# ---------------------------------------------------------------------------
# /config/uploads is swept by default, and before 2.11.0 it was the user's
# own folder name to use: a folder called uploads that predates the add-on's
# inbox lost every file older than 30 days on the first boot after the
# upgrade, whoever made it (an mtime-preserving copy too). The wrapper now
# writes a marker, .ctp-inbox, into the inbox when it makes it
# (files-upload.js), and only a folder holding that marker as a regular file
# is swept. The marker itself is never deleted, however old.
printf '\n%s\n' "prune_upload_inbox: ownership marker"

# An inbox holding one old file, and (with "marked") an old marker.
inbox_with() {
    local dir
    dir="$(new_tmpdir)/uploads"
    mkdir -p "$dir"
    touch -t 202001010000 "$dir/old.pdf"
    if [ "${1:-}" = "marked" ]; then
        printf 'note\n' >"$dir/.ctp-inbox"
        touch -t 202001010000 "$dir/.ctp-inbox"
    fi
    printf '%s\n' "$dir"
}
there() { [ -e "$1" ] && echo yes || echo no; }

reset_config
set_config upload_retention_days 30
dir=$(inbox_with marked)
out=$(prune_upload_inbox "$dir" 2>&1 >/dev/null)
assert_eq "a marked inbox is swept" "no" "$(there "$dir/old.pdf")"
assert_eq "but never its marker, however old" "yes" "$(there "$dir/.ctp-inbox")"
assert_contains "and the count leaves the marker out" "$out" "removed 1 "

dir=$(inbox_with)
out=$(prune_upload_inbox "$dir" 2>&1 >/dev/null)
assert_eq "an inbox without the marker is untouched" "yes" "$(there "$dir/old.pdf")"
assert_contains "and the log says it is skipped" "$out" "${dir} has no .ctp-inbox"
assert_contains "and how to opt in" "$out" "touch ${dir}/.ctp-inbox"
assert_eq "and creates no marker" "no" "$(there "$dir/.ctp-inbox")"

# A symlink is not the marker: `[ -f ]` follows one, so a link to any regular
# file (another folder's marker, say) would pass for it.
dir=$(inbox_with)
other=$(inbox_with marked)
ln -s "$other/.ctp-inbox" "$dir/.ctp-inbox"
out=$(prune_upload_inbox "$dir" 2>&1 >/dev/null)
assert_eq "a symlinked marker does not count" "yes" "$(there "$dir/old.pdf")"
assert_contains "and the log says why" "$out" "is a symlink"
assert_eq "and the link stays" "yes" "$([ -L "$dir/.ctp-inbox" ] && echo yes || echo no)"

dir=$(inbox_with)
mkdir "$dir/.ctp-inbox"
prune_upload_inbox "$dir" 2>/dev/null
assert_eq "a folder named like the marker does not count" "yes" "$(there "$dir/old.pdf")"

# The skip line is logged, never printed: main reads nothing back from this
# function, but bashio logs to LOG_FD and the stub to stderr likewise.
assert_eq "the skip writes nothing to stdout" "" "$(prune_upload_inbox "$(inbox_with)" 2>/dev/null)"

# image_retention_days shares prune_old_files, which spares the marker only
# when asked: a .ctp-inbox among the pasted images is nothing special.
reset_config
set_config image_retention_days 30
dir=$(inbox_with marked)
prune_old_files "$dir" image_retention_days '*' "test files" 2>/dev/null
assert_eq "prune_old_files spares no name unless told to" "no" "$(there "$dir/.ctp-inbox")"
reset_config

dir=$(inbox_with)
other=$(inbox_with)
ln -s "$other/old.pdf" "$other/link"
# shellcheck disable=SC2016  # expanded by the inner shell
assert_status "every skip survives bashio's shell options" 0 run_under_bashio '
    shopt -s inherit_errexit 2>/dev/null || true
    bashio::config() { printf "%s\n" "${2:-}"; }
    . "$REPO_ROOT/claude-terminal/run.sh"
    prune_upload_inbox "$1"
    ln -s "$2/link" "$1/.ctp-inbox"
    prune_upload_inbox "$1"
    [ -e "$1/old.pdf" ]
' "$dir" "$other"

# The wrapper writes the marker and hides it; run.sh looks for it. One name.
assert_contains "the wrapper writes the marker run.sh looks for" \
    "$(grep -E "^const INBOX_MARKER = " "$REPO_ROOT/claude-terminal/wrapper/files-api.js")" "'.ctp-inbox'"
# shellcheck disable=SC2016  # the backticks are Markdown, matched literally
assert_contains "DOCS.md's upload_retention_days row names the marker" \
    "$(grep -E '^\| `upload_retention_days`' "$REPO_ROOT/claude-terminal/DOCS.md")" ".ctp-inbox"

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

# Simulated clock: nothing here really waits. sleep advances SECONDS by its
# argument, and each curl stub advances it by however long that attempt "took".
# shellcheck disable=SC2329  # invoked by wait_for_http
sleep() { SECONDS=$((SECONDS + $1)); }

curl_calls="$sup_dir/curl_calls"
curl_ok_on_third() {
    echo call >> "$curl_calls"
    [ "$(wc -l < "$curl_calls" | tr -d ' ')" -ge 3 ]
}

# An endpoint that accepts the connection and never answers: every attempt
# runs until curl's own --max-time (capped at 2s, like the real call), then
# fails with curl's timeout status.
curl_stalls() {
    local limit=2
    while [ $# -gt 0 ]; do
        [ "$1" = "--max-time" ] && limit="$2"
        shift
    done
    [ "$limit" -gt 2 ] && limit=2
    SECONDS=$((SECONDS + limit))
    return 28
}

rm -f "$curl_calls"
# shellcheck disable=SC2329  # invoked by wait_for_http
curl() { curl_ok_on_third; }
assert_status "succeeds once the endpoint answers" 0 wait_for_http http://127.0.0.1:7680/health 5
assert_eq "stops polling once it has answered" "3" "$(wc -l < "$curl_calls" | tr -d ' ')"

# shellcheck disable=SC2329  # invoked by wait_for_http
curl() { return 7; }
assert_status "fails when the endpoint never answers" 1 wait_for_http http://127.0.0.1:7680/health 3

# The argument is a deadline, not an attempt count. Counting attempts let a
# stalled endpoint stretch a 15s startup wait to 45s: 15 x (2s timeout + 1s).
# shellcheck disable=SC2329  # invoked by wait_for_http
curl() { curl_stalls "$@"; }
started=$SECONDS
wait_for_http http://127.0.0.1:7680/health 15
waited=$((SECONDS - started))
assert_status "gives up by its deadline even when every attempt stalls" 0 test "$waited" -le 15

unset -f curl sleep

finish_suite
