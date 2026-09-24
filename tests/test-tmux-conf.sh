#!/usr/bin/env bash
# Behaviour tests for claude-terminal/scripts/tmux.conf, run against a real tmux.
#
# run.sh rewrites ~/.tmux.conf from the image on every start, because it carries
# the add-on's mouse configuration (CLAUDE.md: "Mouse ownership") and a stale
# copy must never outlive an image update. The cost was that a user's own tmux
# settings, written into that same file in their persistent HOME, vanished on
# the next restart. The managed file now ends by sourcing ~/.tmux.local.conf,
# which run.sh never touches.
#
# Each case starts a private tmux server - its own socket directory and HOME -
# loads the shipped config, and asks tmux what it actually applied.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="tmux.conf"

CONF="$REPO_ROOT/claude-terminal/scripts/tmux.conf"

# Skipping is fine on a laptop without tmux; in CI it would mean the suite
# silently stopped testing anything, so there it fails instead.
if ! command -v tmux >/dev/null 2>&1; then
    if [ -n "${CI:-}" ]; then
        _fail "tmux is required in CI (test.yml installs it)"
    else
        printf '\n  skip tmux is not installed; run in the add-on image to exercise this suite\n'
    fi
    finish_suite
    exit $?
fi

# tmux_query <home> <option> - start a server on the shipped config with HOME
# pointing at <home>, print the global value of <option>, stop the server.
tmux_query() {
    local home="$1" option="$2" sock value
    sock=$(new_tmpdir)
    value=$(
        export HOME="$home" TMUX_TMPDIR="$sock"
        unset TMUX
        tmux -f "$CONF" new-session -d -s probe 2>/dev/null &&
            tmux show-options -gv "$option" 2>/dev/null
        tmux kill-server 2>/dev/null
    )
    printf '%s\n' "$value"
}

printf '\n%s\n' "user overrides in ~/.tmux.local.conf"

home=$(new_tmpdir)
assert_eq "the shipped config loads cleanly with no local file" \
    "1" "$(tmux_query "$home" base-index)"

home=$(new_tmpdir)
printf 'set -g status-left "LOCAL-OVERRIDE"\n' > "$home/.tmux.local.conf"
assert_eq "settings in ~/.tmux.local.conf are applied" \
    "LOCAL-OVERRIDE" "$(tmux_query "$home" status-left)"

# Sourced last, so a user's choice beats the managed default rather than the
# other way round.
home=$(new_tmpdir)
printf 'set -g base-index 0\n' > "$home/.tmux.local.conf"
assert_eq "and override the managed defaults" \
    "0" "$(tmux_query "$home" base-index)"

finish_suite
