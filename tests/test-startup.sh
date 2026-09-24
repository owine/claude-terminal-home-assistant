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

finish_suite
