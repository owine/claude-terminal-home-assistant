#!/usr/bin/env bash
# Unit tests for the two PATH orders in claude-terminal/run.sh
# (set_path_orders): run.sh and the services it starts resolve the system's
# programs first; the terminal keeps the persistent venv and $HOME/.local/bin
# first.
#
# The bug: both folders came first on run.sh's own PATH, and both are writable
# from the terminal. A pip package with a console script named `node`
# (nodejs-wheel-binaries ships one), or any file saved into ~/.local/bin,
# replaced the wrapper's node, the tmux server or ttyd on the next start.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="path order"

# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

host_path="$PATH"
fixture=$(new_tmpdir)
sys="$fixture/sys"           # stands in for /usr/bin and friends
venv="$fixture/venv/bin"     # /data/packages/python/venv/bin
launcher="$fixture/local"    # /data/home/.local/bin
legacy="$fixture/legacy"     # /data/packages/bin
log="$fixture/log"
mkdir -p "$sys" "$venv" "$launcher" "$legacy" "$log"

# The same names in the system and in the venv, each saying which it is.
for name in node tmux; do
    make_stub "$sys/$name" 0 "system $name"
    make_stub "$venv/$name" 0 "venv $name"
done
# Named so no real program on the host can answer instead (claude-test-only
# stands in for claude, which only the launcher folder has in the container).
make_stub "$launcher/claude-test-only" 0 "launcher claude"

# Every case starts from the PATH s6 hands run.sh; set_path_orders reads it.
orders() {
    PATH="$sys:$host_path"
    set_path_orders "$venv:$launcher" "$legacy"
}

# ---------------------------------------------------------------------------
# set_path_orders
# ---------------------------------------------------------------------------
printf '\n%s\n' "set_path_orders"

orders
assert_eq "run.sh's PATH: the system first, then the venv and launcher, legacy last" \
    "$sys:$host_path:$venv:$launcher:$legacy" "$PATH"
assert_eq "the terminal's PATH: the venv and launcher first, legacy last" \
    "$venv:$launcher:$sys:$host_path:$legacy" "$TERMINAL_PATH"
assert_eq "run.sh's node is the system's, not the venv's" "system node" "$(node)"
assert_eq "a program only the launcher folder has is still found (claude)" \
    "launcher claude" "$(claude-test-only)"
assert_eq "in the terminal, the venv's node wins" "venv node" "$(PATH="$TERMINAL_PATH" node)"
assert_eq "TERMINAL_PATH is not exported into run.sh's children" \
    "unset" "$(sh -c 'printf %s "${TERMINAL_PATH-unset}"')"

# ---------------------------------------------------------------------------
# Login shells: the profile script keeps the terminal's order
# ---------------------------------------------------------------------------
# Every pane runs a login shell, and Alpine's /etc/profile resets PATH before
# it sources profile.d - so this file, not run.sh's PATH, is what the panes
# get. It must keep the venv and the launcher first.
printf '\n%s\n' "profile script"

profile="$fixture/persistent-packages.sh"
sed -n "/<< 'PROFILE_EOF'/,/^PROFILE_EOF/p" "$REPO_ROOT/claude-terminal/run.sh" | sed '1d;$d' > "$profile"
assert_contains "the profile script was found in run.sh" "$(cat "$profile")" "export PATH="
login_path=$(env -i PATH=/usr/bin:/bin /bin/bash -c ". '$profile'; printf %s \"\$PATH\"")
assert_eq "a login shell gets the venv and launcher first, legacy last" \
    "/data/packages/python/venv/bin:/data/home/.local/bin:/usr/bin:/bin:/data/packages/bin" "$login_path"

# ---------------------------------------------------------------------------
# setup_tmux_session
# ---------------------------------------------------------------------------
# This call starts the tmux server: the tmux that runs, and the PATH it runs
# with, are what the server keeps. The session environment gets the
# terminal's order.
printf '\n%s\n' "setup_tmux_session"

recording_tmux() {
    cat > "$1/tmux" << EOF
#!/bin/sh
[ "\$1" = has-session ] && exit 1
printf '%s\n' "$2" > "$log/tmux.which"
printf '%s\n' "\$PATH" > "$log/tmux.path"
printf '%s\n' "\$@" > "$log/tmux.args"
EOF
    chmod +x "$1/tmux"
}
recording_tmux "$sys" system
recording_tmux "$venv" venv

rm -f "$log"/tmux.*
(orders; setup_tmux_session "claude" "$fixture" 2>/dev/null)
assert_eq "the system's tmux starts the server, not the venv's" "system" "$(cat "$log/tmux.which" 2>/dev/null)"
assert_eq "and runs with run.sh's system-first PATH" \
    "$sys:$host_path:$venv:$launcher:$legacy" "$(cat "$log/tmux.path" 2>/dev/null)"
assert_contains "the session environment gets the terminal's PATH" \
    "$(cat "$log/tmux.args" 2>/dev/null)" "PATH=$venv:$launcher:$sys:$host_path:$legacy"
assert_contains "the first pane still runs a login shell, which sets it there" \
    "$(cat "$log/tmux.args" 2>/dev/null)" "bash -l -c"

# ---------------------------------------------------------------------------
# run_wrapper
# ---------------------------------------------------------------------------
printf '\n%s\n' "run_wrapper"

out=$(orders; run_wrapper server.js 2>&1)
assert_contains "the wrapper runs the system's node" "$out" "[Wrapper] system node"
assert_not_contains "not a node pip put in the venv" "$out" "venv node"

# ---------------------------------------------------------------------------
# run_init_commands
# ---------------------------------------------------------------------------
# The commands are the user's: they run with the terminal's order, as they
# did before, so `pip` there is still the venv's.
printf '\n%s\n' "run_init_commands"

work=$(new_tmpdir)
# shellcheck disable=SC2016  # $PATH is for the init command's shell to expand
printf '%s\n' '{"init_commands": ["node", "claude-test-only", "printf \"%s\\n\" \"$PATH\""]}' > "$work/options.json"
out=$(orders; ADDON_OPTIONS_FILE="$work/options.json" INIT_COMMANDS_DIR="$work" run_init_commands 2>&1)
assert_contains "an init command runs the venv's node" "$out" "[init] venv node"
assert_contains "and finds the launcher's claude" "$out" "[init] launcher claude"
assert_contains "with the terminal's PATH" "$out" "[init] $venv:$launcher:$sys:"

finish_suite
