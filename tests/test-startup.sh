#!/usr/bin/env bash
# Unit tests for the startup sequence in claude-terminal/run.sh: the order main()
# runs its steps in, and the housekeeping it does on the way.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="startup"

# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

# ---------------------------------------------------------------------------
# main: step order
# ---------------------------------------------------------------------------
# Package installs (apk, pip), Docker CLI setup and ha-mcp registration all
# reach the network, and they ran before the wrapper existed - so for as long as
# they took, ingress had nothing to talk to and Home Assistant showed a bare
# 502. The wrapper has to be serving before any of them start.
#
# The terminal (tmux + ttyd) must still come last: ha-mcp has to be registered
# before the first Claude session launches, and packages should be on PATH when
# it does.
printf '\n%s\n' "main: step order"

order_file=$(new_tmpdir)/order
record() { printf '%s\n' "$1" >> "$order_file"; }

# Replace every step main() calls with a recorder. The real ones touch /data,
# the Supervisor and the network - run_init_commands would run whatever an
# /data/options.json on the test machine lists.
steps="init_environment export_oauth_token export_login_notification export_upload_max_mb prune_uploaded_images
prune_upload_inbox run_health_check setup_session_picker setup_persistent_packages init_docker migrate_legacy_packages setup_ha_mcp
run_init_commands start_wrapper_service start_web_terminal"
for step in $steps; do
    eval "$step() { record $step; }"
done

rm -f "$order_file"
main 2>/dev/null
position() { grep -nx "$1" "$order_file" | cut -d: -f1; }

# A step main() calls that is not in the list above runs for real. Catch one
# added later: every function main() names must have been recorded. Its body
# is tokenised rather than matched line by line, so a call with arguments, a
# redirect, in an && / || chain or inside an if still counts; the words kept
# are those naming a function, apart from bashio's own.
# (A function, not inline: bash 3.2 cannot parse a case inside $(...).)
function_words() {
    local word
    while IFS= read -r word; do
        case "$word" in ''|bashio::*) continue ;; esac
        if declare -F "$word" >/dev/null 2>&1; then printf '%s\n' "$word"; fi
    done
}
main_steps=$(declare -f main | tail -n +3 | tr -s ' \t;|&()' '\n' | function_words)
assert_status "main's steps are found (else the next check checks nothing)" 0 \
    test "$(printf '%s\n' "$main_steps" | grep -c .)" -ge 10
for called in $main_steps; do
    assert_status "main's step $called is stubbed and recorded" 0 grep -qx "$called" "$order_file"
done

wrapper=$(position start_wrapper_service)
assert_status "main starts the wrapper itself" 0 test -n "$wrapper"
for slow in setup_persistent_packages init_docker setup_ha_mcp; do
    assert_status "the wrapper is serving before $slow" 0 test "${wrapper:-999}" -lt "$(position "$slow")"
done
assert_eq "the terminal still starts last" "start_web_terminal" "$(tail -1 "$order_file")"
# The wrapper reads UPLOAD_MAX_MB when it starts, and the inbox is swept while
# no upload can be in flight.
for early in export_upload_max_mb prune_upload_inbox; do
    assert_status "$early runs before the wrapper starts" 0 test "$(position "$early")" -lt "${wrapper:-0}"
done
# The wrapper decides at start whether to run the login notifier, from
# LOGIN_NOTIFICATION and CLAUDE_CODE_OAUTH_TOKEN - so both are exported before
# it starts.
for early in export_oauth_token export_login_notification; do
    assert_status "$early runs before the wrapper starts" 0 test "$(position "$early")" -lt "${wrapper:-0}"
done
# Legacy migration skips any command the restore, the option packages or the
# Docker CLI already installed, so it runs after all three.
for before in setup_persistent_packages init_docker; do
    assert_status "migrate_legacy_packages runs after $before" 0 \
        test "$(position "$before")" -lt "$(position migrate_legacy_packages)"
done
# init_commands may use persistent packages and the Docker CLI, and must be
# done before the terminal opens.
init_cmds=$(position run_init_commands)
for before in setup_persistent_packages init_docker; do
    assert_status "run_init_commands runs after $before" 0 test "$(position "$before")" -lt "${init_cmds:-0}"
done
assert_status "run_init_commands runs before the terminal starts" 0 \
    test "${init_cmds:-999}" -lt "$(position start_web_terminal)"

# The eval'd recorders above replace main()'s steps for the rest of this file,
# so re-source run.sh to get the real functions back.
# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

# With start_web_terminal stubbed, the order above cannot see inside it. It used
# to start the wrapper itself; a second start would race the first for 7680.
assert_eq "start_web_terminal no longer starts the wrapper itself" "0" \
    "$(declare -f start_web_terminal | grep -c start_wrapper_service)"

# ---------------------------------------------------------------------------
# prune_uploaded_images
# ---------------------------------------------------------------------------
# Every pasted or dropped image lands in /data/images and nothing ever removed
# one. /data is in every Home Assistant backup, so the folder grew those
# without bound. Pruning is by age, configurable, and only ever touches the
# wrapper's own `pasted-*` files - never anything a user put there.
printf '\n%s\n' "prune_uploaded_images"

# Fixture: an uploads directory holding one long-expired upload, one fresh
# upload, and one old file the wrapper did not create.
new_uploads() {
    local dir
    dir=$(new_tmpdir)
    touch -t 202001010000 "$dir/pasted-1577836800000.png"
    touch "$dir/pasted-9999999999999.png"
    touch -t 202001010000 "$dir/my-diagram.png"
    printf '%s\n' "$dir"
}
present() { [ -e "$1" ] && echo yes || echo no; }

reset_config
dir=$(new_uploads)
set_config image_retention_days 30
prune_uploaded_images "$dir" 2>/dev/null
assert_eq "removes an upload older than the retention period" "no" "$(present "$dir/pasted-1577836800000.png")"
assert_eq "keeps a recent upload" "yes" "$(present "$dir/pasted-9999999999999.png")"
assert_eq "never touches a file the wrapper did not create" "yes" "$(present "$dir/my-diagram.png")"

reset_config
dir=$(new_uploads)
prune_uploaded_images "$dir" 2>/dev/null
assert_eq "prunes by default when the option is unset" "no" "$(present "$dir/pasted-1577836800000.png")"

reset_config
dir=$(new_uploads)
set_config image_retention_days 0
prune_uploaded_images "$dir" 2>/dev/null
assert_eq "0 keeps every upload" "yes" "$(present "$dir/pasted-1577836800000.png")"

# Deleting on a value that could not be read is the one unrecoverable
# mistake available here, so anything that is not a whole number keeps all.
# Real bashio::config returns an empty string - not the default - when the
# Supervisor API is unreachable. Empty must keep everything too.
reset_config
dir=$(new_uploads)
set_config image_retention_days ""
out=$(prune_uploaded_images "$dir" 2>&1 >/dev/null)
assert_eq "an unreadable (empty) value deletes nothing" "yes" "$(present "$dir/pasted-1577836800000.png")"
assert_contains "and says why" "$out" "could not be read"

for bad in "null" "thirty" "-5" "1.5"; do
    reset_config
    dir=$(new_uploads)
    set_config image_retention_days "$bad"
    prune_uploaded_images "$dir" 2>/dev/null
    assert_eq "an unusable value ($bad) deletes nothing" "yes" "$(present "$dir/pasted-1577836800000.png")"
done

reset_config
out=$(prune_uploaded_images "$(new_uploads)" 2>&1 >/dev/null)
assert_contains "logs how many uploads it removed" "$out" "removed 1"

reset_config
assert_status "succeeds when the uploads directory does not exist yet" 0 \
    prune_uploaded_images "$(new_tmpdir)/missing"

dir=$(new_uploads)
# shellcheck disable=SC2016  # expanded by the inner shell
assert_status "survives bashio's shell options" 0 bash -c '
    set -o errexit -o errtrace -o nounset -o pipefail
    shopt -s inherit_errexit 2>/dev/null || true
    bashio::log.info() { :; }
    bashio::log.warning() { :; }
    bashio::config() { printf "%s\\n" "${2:-}"; }
    . "$1/claude-terminal/run.sh"
    prune_uploaded_images "$2"
    prune_uploaded_images "$2/missing"
' _ "$REPO_ROOT" "$dir"
reset_config

# ---------------------------------------------------------------------------
# prune_upload_inbox
# ---------------------------------------------------------------------------
# The Files sidebar's inbox (/config/uploads) is disposable by contract: every
# regular file at its top level goes once it is older than
# upload_retention_days, whatever its name. Never a subfolder or anything in
# one, never a symlink, never anything outside, and never an inbox that is
# itself a symlink or a file.
printf '\n%s\n' "prune_upload_inbox"

# Fixture: an inbox the add-on made (it holds the .ctp-inbox marker; the
# marker itself is tested in test-run-helpers.sh), with old files of any name
# (a dotfile among them), a new one, a subfolder holding an old file, and an
# old symlink to an old file outside the inbox. Prints the inbox; the outside
# folder is beside it.
new_inbox() {
    local base dir
    base=$(new_tmpdir)
    dir="$base/uploads"
    mkdir -p "$dir/sub" "$base/outside"
    touch "$dir/.ctp-inbox"
    touch -t 202001010000 "$dir/report.pdf" "$dir/.hidden-old" "$dir/sub/old-inside.txt" "$base/outside/target.txt"
    touch "$dir/fresh.txt"
    ln -s "$base/outside/target.txt" "$dir/old-link"
    touch -h -t 202001010000 "$dir/old-link"
    printf '%s\n' "$dir"
}

reset_config
dir=$(new_inbox)
set_config upload_retention_days 30
out=$(prune_upload_inbox "$dir" 2>&1 >/dev/null)
assert_eq "removes an old file of any name" "no" "$(present "$dir/report.pdf")"
assert_eq "removes an old dotfile too" "no" "$(present "$dir/.hidden-old")"
assert_eq "keeps a new file" "yes" "$(present "$dir/fresh.txt")"
assert_eq "keeps a subfolder's files" "yes" "$(present "$dir/sub/old-inside.txt")"
assert_eq "keeps a symlink" "yes" "$([ -L "$dir/old-link" ] && echo yes || echo no)"
assert_eq "keeps the symlink's target" "yes" "$(present "$dir/../outside/target.txt")"
assert_contains "logs how many it removed" "$out" "removed 2"

reset_config
dir=$(new_inbox)
prune_upload_inbox "$dir" 2>/dev/null
assert_eq "sweeps by default when the option is unset" "no" "$(present "$dir/report.pdf")"

reset_config
dir=$(new_inbox)
set_config upload_retention_days 0
prune_upload_inbox "$dir" 2>/dev/null
assert_eq "0 keeps every file" "yes" "$(present "$dir/report.pdf")"

reset_config
dir=$(new_inbox)
set_config upload_retention_days ""
out=$(prune_upload_inbox "$dir" 2>&1 >/dev/null)
assert_eq "an unreadable (empty) value deletes nothing" "yes" "$(present "$dir/report.pdf")"
assert_contains "and says why" "$out" "upload_retention_days could not be read"

# A symlinked inbox is never swept, and says so. find would not descend into
# it today (-P is find's default), so the log line is what proves the guard:
# without it, this case is silent.
reset_config
dir=$(new_inbox)
link_base=$(new_tmpdir)
ln -s "$dir" "$link_base/uploads"
out=$(prune_upload_inbox "$link_base/uploads" 2>&1 >/dev/null)
assert_contains "a symlinked inbox is skipped, with a log line" "$out" "is a symlink"
assert_eq "and its target is untouched" "yes" "$(present "$dir/report.pdf")"

reset_config
file_base=$(new_tmpdir)
touch "$file_base/uploads"
out=$(prune_upload_inbox "$file_base/uploads" 2>&1 >/dev/null)
assert_contains "an inbox that is a file is skipped, with a log line" "$out" "is not a folder"
assert_eq "and the file is untouched" "yes" "$(present "$file_base/uploads")"

# A sweep that fails (here, an inbox find cannot read) must not stop startup:
# bashio runs run.sh with errexit and pipefail, and the add-on would never come
# up. Root reads anything, so this case needs a non-root run (CI, a Mac).
# Searchable but not readable: the marker is found, the listing is not.
if [ "$(id -u)" -ne 0 ]; then
    dir=$(new_inbox)
    chmod 300 "$dir"
    # shellcheck disable=SC2016  # expanded by the inner shell
    out=$(bash -c '
        set -o errexit -o errtrace -o nounset -o pipefail
        shopt -s inherit_errexit 2>/dev/null || true
        bashio::log.info() { :; }
        bashio::log.warning() { printf "WARNING: %s\n" "$*" >&2; }
        bashio::config() { printf "%s\n" "${2:-}"; }
        . "$1/claude-terminal/run.sh"
        prune_upload_inbox "$2"
        echo "startup goes on"
    ' _ "$REPO_ROOT" "$dir" 2>&1)
    chmod 755 "$dir"
    assert_contains "a sweep that fails does not stop startup" "$out" "startup goes on"
    assert_contains "and says it could not sweep" "$out" "could not sweep all of"
    assert_eq "and deletes nothing" "yes" "$(present "$dir/report.pdf")"
else
    printf '  skip a failing sweep (running as root, which reads anything)\n'
fi

reset_config
assert_status "succeeds when the inbox does not exist yet" 0 prune_upload_inbox "$(new_tmpdir)/uploads"
assert_eq "and says nothing then" "" "$(prune_upload_inbox "$(new_tmpdir)/uploads" 2>&1)"

dir=$(new_inbox)
# shellcheck disable=SC2016  # expanded by the inner shell
assert_status "survives bashio's shell options" 0 bash -c '
    set -o errexit -o errtrace -o nounset -o pipefail
    shopt -s inherit_errexit 2>/dev/null || true
    bashio::log.info() { :; }
    bashio::log.warning() { :; }
    bashio::config() { printf "%s\\n" "${2:-}"; }
    . "$1/claude-terminal/run.sh"
    prune_upload_inbox "$2"
    prune_upload_inbox "$2/missing"
    ln -s "$2" "$2-link"
    prune_upload_inbox "$2-link"
' _ "$REPO_ROOT" "$dir"
reset_config

finish_suite
