#!/usr/bin/env bash
# Unit tests for claude-terminal/scripts/setup-ha-mcp.sh: what it registers
# with `claude mcp add`, with the claude CLI stubbed to record its arguments.
#
# setup-ha-mcp.sh guards its entrypoint with a BASH_SOURCE check, so sourcing
# it here defines configure_ha_mcp_server without running it.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="setup-ha-mcp.sh"

# The script under test sets `set -e`, which the sourcing shell inherits. Turn
# it back off so an assertion failure reports instead of aborting the suite.
# shellcheck source=claude-terminal/scripts/setup-ha-mcp.sh
. "$REPO_ROOT/claude-terminal/scripts/setup-ha-mcp.sh"
set +e

# A claude stub that appends each invocation's arguments, one per line, then a
# separator, so assertions can look for exact arguments.
stubs=$(new_tmpdir)
cat > "$stubs/claude" <<EOF
#!/bin/sh
for arg in "\$@"; do printf '%s\n' "\$arg"; done >> "$stubs/claude.log"
echo --- >> "$stubs/claude.log"
EOF
chmod +x "$stubs/claude"

fake_bin=$(new_tmpdir)/ha-mcp
: > "$fake_bin" && chmod +x "$fake_bin"

register() {
    rm -f "$stubs/claude.log"
    ( PATH="$stubs:$PATH"; HA_MCP_BIN="$fake_bin"; SUPERVISOR_TOKEN=live-token; configure_ha_mcp_server ) 2>/dev/null
}
registered() { cat "$stubs/claude.log" 2>/dev/null; }

# ---------------------------------------------------------------------------
# configure_ha_mcp_server
# ---------------------------------------------------------------------------
printf '\n%s\n' "configure_ha_mcp_server"

reset_config
register
added=$(registered)
assert_contains "the server is registered with claude mcp add" "$added" "add"
assert_contains "pointing at the image's ha-mcp binary" "$added" "$fake_bin"
assert_contains "with the Supervisor's Core API URL" "$added" "HOMEASSISTANT_URL=http://supervisor/core"

# The live token stays out of ~/.claude.json (and so out of every backup):
# claude expands ${SUPERVISOR_TOKEN} from its own environment at launch.
# shellcheck disable=SC2016  # the literal ${SUPERVISOR_TOKEN} is the point
assert_contains "the token is registered as the unexpanded variable" "$added" 'HOMEASSISTANT_TOKEN=${SUPERVISOR_TOKEN}'
assert_not_contains "never as its value" "$added" "live-token"

# ha-mcp checks PyPI for a newer ha-mcp, and its bundled fastmcp for a newer
# fastmcp, before it answers Claude's MCP handshake. Each lookup blocks for the
# resolver's ~5 s timeout when DNS is not answering yet, as at boot: that alone
# added ~10 s to startup, which pushed a slow box past Claude Code's 30 s MCP
# startup timeout, so the server came up "failed" until reconnected. Both
# checks are pointless here anyway: the image pins ha-mcp and Renovate bumps it.
assert_contains "ha-mcp's own update check is off" "$added" "HA_MCP_DISABLE_UPDATE_CHECK=true"
assert_contains "and the bundled fastmcp's" "$added" "FASTMCP_CHECK_FOR_UPDATES=off"

reset_config
set_config enable_ha_mcp "false"
register
assert_eq "enable_ha_mcp false registers nothing" "" "$(registered)"

finish_suite
