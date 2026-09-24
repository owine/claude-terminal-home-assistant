#!/usr/bin/env bash
# Unit tests for claude-terminal/scripts/claude-session-picker.sh - the menu
# every terminal opens into.
#
# The picker guards its main loop with a BASH_SOURCE check, so sourcing it
# here defines the functions without starting the menu. `claude` is replaced
# by a stub that records the argv and IS_SANDBOX it was launched with.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="claude-session-picker.sh"

# shellcheck source=claude-terminal/scripts/claude-session-picker.sh
. "$REPO_ROOT/claude-terminal/scripts/claude-session-picker.sh"

# The launch paths pause for effect; the tests have no use for that.
sleep() { :; }
clear() { :; }

fixture=$(new_tmpdir)
record="$fixture/argv"

# A claude that writes each argument on its own line, bracketed so empty and
# space-containing arguments are visible, then IS_SANDBOX's value.
CLAUDE_BIN="$fixture/claude"
cat > "$CLAUDE_BIN" <<'EOF'
#!/bin/sh
out="$CLAUDE_RECORD"
: > "$out"
for a in "$@"; do printf '[%s]\n' "$a" >> "$out"; done
printf 'IS_SANDBOX=%s\n' "${IS_SANDBOX-<unset>}" >> "$out"
EOF
chmod +x "$CLAUDE_BIN"
export CLAUDE_RECORD="$record"

# Feed one line to the custom-command prompt and return what claude received.
custom() {
    rm -f "$record"
    printf '%s\n' "$1" | run_claude_custom >/dev/null 2>&1
    if [ -f "$record" ]; then cat "$record"; else printf '<claude not run>\n'; fi
}

nl=$'\n'
unset CLAUDE_DANGEROUS_MODE IS_SANDBOX

# --- custom command: argument parsing --------------------------------------
#
# Background: the line was run as `$CLAUDE_BIN $custom_args` - unquoted word
# splitting. Quotes the user typed reached claude as literal characters, so
# the prompt's own example, -p "hello", sent claude the prompt `"hello"`, and
# any multi-word prompt was split into separate arguments.

printf '\n%s\n' "run_claude_custom: quoting"

assert_eq "a double-quoted prompt arrives as one argument, without quotes" \
    "[-p]${nl}[hello world]${nl}IS_SANDBOX=<unset>" "$(custom '-p "hello world"')"

assert_eq "single quotes work too" \
    "[-p]${nl}[say \"hi\" now]${nl}IS_SANDBOX=<unset>" "$(custom "-p 'say \"hi\" now'")"

assert_eq "a backslash escapes outside quotes" \
    "[-p]${nl}[a b]${nl}IS_SANDBOX=<unset>" "$(custom '-p a\ b')"

assert_eq "backslash-quote inside double quotes is a literal quote" \
    "[-p]${nl}[say \"hi\"]${nl}IS_SANDBOX=<unset>" "$(custom '-p "say \"hi\""')"

assert_eq "an explicitly empty argument is kept" \
    "[--model]${nl}[]${nl}IS_SANDBOX=<unset>" "$(custom '--model ""')"

assert_eq "adjacent quoted and bare text join into one argument" \
    "[--flag=a b]${nl}IS_SANDBOX=<unset>" "$(custom '--flag="a b"')"

assert_eq "runs of blanks separate arguments without adding empty ones" \
    "[-c]${nl}[--verbose]${nl}IS_SANDBOX=<unset>" "$(custom '   -c 	  --verbose  ')"

# --- custom command: nothing is expanded or executed -----------------------
#
# The easy quote-aware parser is `eval "set -- $line"`, which would also run
# command substitutions typed at the prompt. Parsing must never execute.

printf '\n%s\n' "run_claude_custom: no expansion"

marker="$fixture/pwned"
assert_eq "command substitution is passed through literally" \
    "[-p]${nl}[\$(touch $marker)]${nl}IS_SANDBOX=<unset>" "$(custom "-p \"\$(touch $marker)\"")"
assert_eq "and never runs" "absent" "$([ -e "$marker" ] && echo present || echo absent)"

assert_eq "backticks and semicolons stay literal (and do not quote)" \
    "[-p]${nl}[\`touch]${nl}[$marker\`;]${nl}IS_SANDBOX=<unset>" "$(custom "-p \`touch $marker\`;")"
assert_eq "and never run" "absent" "$([ -e "$marker" ] && echo present || echo absent)"

# shellcheck disable=SC2016  # an unexpanded $HOME is exactly what is typed
assert_eq "variables and globs stay literal" \
    "[-p]${nl}[\$HOME]${nl}[*]${nl}IS_SANDBOX=<unset>" "$(custom '-p $HOME *')"

assert_eq "an unterminated quote runs nothing" \
    "<claude not run>" "$(custom '-p "oops')"

# --- custom command: the leading `claude` ----------------------------------
#
# The prompt reads `> claude ` but its own help text says to type
# 'claude --help', which ran `claude claude --help`.

printf '\n%s\n' "run_claude_custom: leading claude"

assert_eq "a typed leading 'claude' is dropped" \
    "[--help]${nl}IS_SANDBOX=<unset>" "$(custom 'claude --help')"

assert_eq "the prompt's own example works as written" \
    "[-p]${nl}[hello]${nl}IS_SANDBOX=<unset>" "$(custom 'claude -p "hello"')"

assert_eq "only a leading 'claude' is dropped, not a later one" \
    "[-p]${nl}[claude]${nl}IS_SANDBOX=<unset>" "$(custom '-p claude')"

assert_eq "'claude' alone starts a default session" \
    "IS_SANDBOX=<unset>" "$(custom 'claude')"

assert_eq "an empty line starts a default session" \
    "IS_SANDBOX=<unset>" "$(custom '')"

# --- dangerous mode reaches claude -----------------------------------------
#
# Background: get_claude_flags exported IS_SANDBOX=1, but every caller ran it
# as $(get_claude_flags) - a subshell - so the export died with it and never
# reached the claude it was for. Claude refuses
# --dangerously-skip-permissions as root without it.

printf '\n%s\n' "dangerous mode"

launch() {
    rm -f "$record"
    "$@" >/dev/null 2>&1
    cat "$record"
}

export CLAUDE_DANGEROUS_MODE=true
assert_eq "new session gets the flag and IS_SANDBOX=1" \
    "[--dangerously-skip-permissions]${nl}IS_SANDBOX=1" "$(launch run_claude_new)"
assert_eq "continue gets both" \
    "[-c]${nl}[--dangerously-skip-permissions]${nl}IS_SANDBOX=1" "$(launch run_claude_continue)"
assert_eq "resume gets both" \
    "[-r]${nl}[--dangerously-skip-permissions]${nl}IS_SANDBOX=1" "$(launch run_claude_resume)"
assert_eq "a custom command gets both" \
    "[-p]${nl}[a b]${nl}[--dangerously-skip-permissions]${nl}IS_SANDBOX=1" "$(custom '-p "a b"')"

# Scoped to the claude command, like the YOLO path: the menu's own
# environment - and the bash shell option 7 execs into - is left alone.
run_claude_new >/dev/null 2>&1
assert_eq "IS_SANDBOX is not left set in the picker afterwards" "<unset>" "${IS_SANDBOX-<unset>}"

unset CLAUDE_DANGEROUS_MODE
assert_eq "without dangerous mode, neither is passed" \
    "IS_SANDBOX=<unset>" "$(launch run_claude_new)"

finish_suite
