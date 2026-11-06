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

# osc52_probe <home> <selection> - on the shipped config, copy a line in
# copy-mode (what a mouse drag does), then have programs in two new windows
# write <selection> with OSC 52, and ask for the clipboard with an OSC 52 read.
# Prints the read's reply, as cat -v shows it, then the top buffer's content.
osc52_probe() {
    local home="$1" selection="$2" sock probe out
    sock=$(new_tmpdir)
    probe=$(new_tmpdir)
    out="$probe/reply"
    # Raw, and a read gives up after a second without input (min 0 time 10;
    # no timeout(1) on macOS): dd stops at the first read that times out.
    cat > "$probe/read" <<'EOF'
#!/bin/sh
stty raw -echo min 0 time 10
printf '\033]52;c;?\007'
dd bs=128 count=8 of="$1" 2>/dev/null
stty sane
EOF
    # Each probe gets its own server: HOME and the socket directory are set
    # per command, so nothing leaks into the suite's environment.
    local t=(env -u TMUX HOME="$home" TMUX_TMPDIR="$sock" tmux)
    "${t[@]}" -f "$CONF" new-session -d -s probe -x 80 -y 20 "echo copied-by-admin; sleep 30" 2>/dev/null || return 0
    sleep 0.5
    "${t[@]}" copy-mode -t probe
    "${t[@]}" send-keys -t probe -X history-top
    "${t[@]}" send-keys -t probe -X select-line
    "${t[@]}" send-keys -t probe -X copy-selection-and-cancel
    "${t[@]}" new-window -d -t probe "sh '$probe/read' '$out'"
    sleep 2
    "${t[@]}" new-window -d -t probe "printf '\033]52;c;%s\007' '$(printf '%s' "$selection" | base64)'; sleep 1"
    sleep 1
    cat -v "$out" 2>/dev/null
    printf '|'
    "${t[@]}" show-buffer 2>/dev/null
    "${t[@]}" kill-server 2>/dev/null
}

printf '\n%s\n' "OSC 52: applications may write the clipboard, never read it"

home=$(new_tmpdir)
assert_eq "set-clipboard is on, so writes reach tmux and the wrapper" "on" "$(tmux_query "$home" set-clipboard)"
assert_eq "get-clipboard is off" "off" "$(tmux_query "$home" get-clipboard)"

# The default (get-clipboard buffer) answered a read with the line the admin
# had just copied: ESC]52;c;Y29waWVkLWJ5LWFkbWluCg==BEL.
result=$(osc52_probe "$home" written-by-pane)
assert_eq "a pane's OSC 52 read gets no reply, the admin's copy stays private" "" "${result%%|*}"
assert_eq "and a pane's OSC 52 write still becomes the top buffer" "written-by-pane" "${result#*|}"

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
