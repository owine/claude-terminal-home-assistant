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
# the Supervisor and the network.
steps="init_environment export_oauth_token prune_uploaded_images run_health_check setup_session_picker
setup_persistent_packages init_docker setup_ha_mcp start_wrapper_service start_web_terminal"
for step in $steps; do
    eval "$step() { record $step; }"
done

rm -f "$order_file"
main 2>/dev/null
position() { grep -nx "$1" "$order_file" | cut -d: -f1; }

wrapper=$(position start_wrapper_service)
assert_status "main starts the wrapper itself" 0 test -n "$wrapper"
for slow in setup_persistent_packages init_docker setup_ha_mcp; do
    assert_status "the wrapper is serving before $slow" 0 test "${wrapper:-999}" -lt "$(position "$slow")"
done
assert_eq "the terminal still starts last" "start_web_terminal" "$(tail -1 "$order_file")"

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
    bashio::log.info() { :; }
    bashio::log.warning() { :; }
    bashio::config() { printf "%s\\n" "${2:-}"; }
    . "$1/claude-terminal/run.sh"
    prune_uploaded_images "$2"
    prune_uploaded_images "$2/missing"
' _ "$REPO_ROOT" "$dir"
reset_config

finish_suite
