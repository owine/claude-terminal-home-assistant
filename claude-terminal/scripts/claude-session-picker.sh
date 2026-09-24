#!/bin/bash

# Claude Terminal Menu - Interactive menu for Claude session management
# Provides options for new session, continue, resume, custom commands, and tools
#
# With tmux integration, this menu is the "home base" - when Claude exits,
# user returns here to start a new session or access other tools.

# Claude binary (now in PATH via /root/.local/bin)
CLAUDE_BIN="claude"

# Run claude with the given arguments, adding the dangerous-mode flags when the
# add-on's CLAUDE_DANGEROUS_MODE is enabled.
# In dangerous mode, IS_SANDBOX=1 bypasses Claude CLI's refusal to run
# --dangerously-skip-permissions as root (required in the container). This is
# an undocumented workaround.
# IS_SANDBOX is scoped to the claude command, as in run_claude_yolo(). This
# used to be an `export` inside a function that every caller ran as
# $(get_claude_flags) - a subshell - so it never reached claude at all.
launch_claude() {
    if [ "${CLAUDE_DANGEROUS_MODE}" = "true" ]; then
        echo "⚠️  Running in DANGEROUS mode (unrestricted file access)" >&2
        IS_SANDBOX=1 "$CLAUDE_BIN" "$@" --dangerously-skip-permissions
    else
        "$CLAUDE_BIN" "$@"
    fi
}

# Split a typed command line into words the way a shell would quote them, and
# store them in the PARSED_ARGS array. Returns 1 on an unterminated quote.
#
# Why a hand-rolled parser:
# - Unquoted $line word-splits and globs but ignores quotes, so -p "hello"
#   reached claude as the two-character-longer `"hello"`, and `?` or `*` in a
#   prompt could expand to file names.
# - `eval "set -- $line"` honours quotes but also runs $(...) and backticks:
#   the menu would execute whatever was typed at it.
# - `read -a` is not quote-aware, and xargs' quote handling differs between
#   busybox, GNU and BSD.
# This handles the quoting subset people actually type: blanks separate words;
# '...' is literal; "..." is literal except that \ escapes " \ $ and `; a bare
# \ escapes the next character. Nothing is ever expanded or executed - $VAR,
# $(...), `...`, ~ and globs all reach claude as typed.
parse_command_line() {
    local line="$1" len=${#1} i=0 c next word="" in_word=0 quote=""
    PARSED_ARGS=()
    while [ "$i" -lt "$len" ]; do
        c="${line:i:1}"
        if [ "$quote" = "'" ]; then
            if [ "$c" = "'" ]; then quote=""; else word+="$c"; fi
        elif [ "$quote" = '"' ]; then
            if [ "$c" = '"' ]; then
                quote=""
            elif [ "$c" = "\\" ]; then
                next="${line:i+1:1}"
                case "$next" in
                    '"'|"\\"|'$'|'`')
                        word+="$next"
                        i=$((i + 1))
                        ;;
                    *)
                        word+="$c"
                        ;;
                esac
            else
                word+="$c"
            fi
        else
            case "$c" in
                ' '|$'\t')
                    if [ "$in_word" = 1 ]; then
                        PARSED_ARGS+=("$word")
                        word=""
                        in_word=0
                    fi
                    ;;
                "'"|'"')
                    quote="$c"
                    in_word=1
                    ;;
                "\\")
                    i=$((i + 1))
                    word+="${line:i:1}"
                    in_word=1
                    ;;
                *)
                    word+="$c"
                    in_word=1
                    ;;
            esac
        fi
        i=$((i + 1))
    done
    [ -z "$quote" ] || return 1
    if [ "$in_word" = 1 ]; then
        PARSED_ARGS+=("$word")
    fi
}

show_banner() {
    clear
    echo "╔════════════════════════════════════════╗"
    echo "║         🤖  Claude Terminal Menu       ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
}

is_yolo_enabled() {
    [ "${ALLOW_YOLO_MODE:-0}" = "1" ]
}

show_menu() {
    echo "  Choose your session type:"
    echo ""
    echo "   1) 🆕  New session"
    echo "   2) ⏩  Continue (-c)"
    echo "   3) 📋  Resume (-r)"
    echo "   4) ⚙️   Custom command"
    echo "   5) 🔐  Auth helper"
    echo "   6) 🐙  GitHub login"
    echo "   7) 🐚  Bash shell"
    echo "   8) 🔄  Restart"
    if is_yolo_enabled; then
        echo "   ────────────────────────────────────"
        echo "   9) ☢️   YOLO Mode"
    fi
    echo ""
}

get_user_choice() {
    local choice
    local max_choice="8"
    if is_yolo_enabled; then
        max_choice="9"
    fi
    printf "Enter your choice [1-%s] (default: 1): " "$max_choice" >&2
    read -r choice

    if [ -z "$choice" ]; then
        choice="1"
    fi

    choice=$(echo "$choice" | tr -d '[:space:]')
    echo "$choice"
}

# Show a message when returning from Claude
show_return_message() {
    echo ""
    echo "────────────────────────────────────────"
    echo "  Session ended. Returning to menu..."
    echo "────────────────────────────────────────"
    sleep 2
}

# Run Claude and return to picker when done (no exec)
run_claude_new() {
    echo "🚀 Starting new Claude session..."
    sleep 1
    launch_claude
    show_return_message
}

run_claude_continue() {
    echo "⏩ Continuing most recent conversation..."
    sleep 1
    launch_claude -c
    show_return_message
}

run_claude_resume() {
    echo "📋 Opening conversation list for selection..."
    sleep 1
    launch_claude -r
    show_return_message
}

run_claude_custom() {
    local custom_line
    echo ""
    echo "Enter your Claude command (e.g., 'claude --help' or 'claude -p \"hello\"'):"
    echo "Available flags: -c (continue), -r (resume), -p (print), --model,"
    echo "                 --dangerously-skip-permissions, etc."
    if [ "${CLAUDE_DANGEROUS_MODE}" = "true" ]; then
        echo "Note: --dangerously-skip-permissions will be automatically added"
    fi
    echo -n "> claude "
    read -r custom_line

    # IMPORTANT: Do NOT use eval here - it runs $(...) typed at the prompt.
    # See parse_command_line.
    if ! parse_command_line "$custom_line"; then
        echo ""
        echo "❌ Unterminated quote in: $custom_line"
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
        return
    fi

    # The prompt already shows `claude`, but its help text says to type
    # 'claude --help' - which used to run `claude claude --help`.
    if [ "${#PARSED_ARGS[@]}" -gt 0 ] && [ "${PARSED_ARGS[0]}" = "claude" ]; then
        PARSED_ARGS=("${PARSED_ARGS[@]:1}")
    fi

    if [ "${#PARSED_ARGS[@]}" -eq 0 ]; then
        echo "No arguments provided. Starting default session..."
        run_claude_new
    else
        printf '🚀 Running: claude'
        printf ' %q' "${PARSED_ARGS[@]}"
        printf '\n'
        sleep 1
        launch_claude "${PARSED_ARGS[@]}"
        show_return_message
    fi
}

run_auth_helper() {
    echo "🔐 Starting Claude authentication helper..."
    sleep 1
    if [ -f "/opt/scripts/claude-auth-helper.sh" ]; then
        /opt/scripts/claude-auth-helper.sh
    else
        echo "❌ Auth helper script not found at /opt/scripts/claude-auth-helper.sh"
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
    fi
}

run_github_auth() {
    echo ""
    echo "🐙  GitHub CLI Authentication"
    echo "────────────────────────────────"
    echo ""

    if ! command -v gh &>/dev/null; then
        echo "❌ GitHub CLI (gh) is not installed!"
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
        return
    fi

    echo "Checking current authentication status..."
    echo ""
    if gh auth status 2>/dev/null; then
        echo ""
        echo "✅ You are already authenticated!"
        echo ""
        echo "Options:"
        echo "  1) Keep current login"
        echo "  2) Login to a different account"
        echo ""
        printf "Choice [1-2] (default: 1): " >&2
        read -r auth_choice

        if [ "$auth_choice" != "2" ]; then
            echo ""
            printf "Press Enter to return to menu..." >&2
            read -r
            return
        fi
    fi

    echo ""
    echo "Choose authentication method:"
    echo ""
    echo "  1) 🌐 Browser login (if you have browser access)"
    echo "  2) 🔑 Token login (recommended for containers)"
    echo ""
    printf "Choice [1-2] (default: 2): " >&2
    read -r method_choice

    echo ""
    if [ "$method_choice" = "1" ]; then
        echo "Starting browser authentication..."
        gh auth login --web
    else
        echo "To create a personal access token:"
        echo ""
        echo "  1. Go to: https://github.com/settings/tokens"
        echo "  2. Click 'Generate new token (classic)'"
        echo "  3. Select scopes: repo, read:org, workflow"
        echo "  4. Generate and copy the token"
        echo ""
        gh auth login -p https -h github.com
    fi

    echo ""
    echo "Verifying authentication..."
    if gh auth status 2>/dev/null; then
        echo ""
        echo "✅ GitHub authentication successful!"
        echo "   Credentials saved to: $GH_CONFIG_DIR"
        echo "   They will persist across reboots."
    else
        echo ""
        echo "⚠️  Authentication may have failed. Try again or use 'gh auth login' from bash."
    fi

    echo ""
    printf "Press Enter to return to menu..." >&2
    read -r
}

# Clear and restart the session fresh
restart_session() {
    echo "🔄 Clearing session and restarting..."
    sleep 1

    # Clear tmux scrollback buffer if we're in tmux
    if [ -n "$TMUX" ]; then
        tmux clear-history 2>/dev/null || true
    fi

    # Clear the screen
    clear

    # Re-exec this script for a fresh start
    exec "$0"
}

# Drop to bash shell - uses exec to exit the menu permanently
drop_to_bash() {
    echo "🐚 Dropping to bash shell..."
    echo ""
    echo "Tips:"
    echo "  • Run 'menu' to return to this menu"
    echo "  • Run 'claude' to start a new Claude session"
    echo "  • Run 'claude -c' to continue most recent conversation"
    echo "  • Run 'claude -r' to resume from conversation list"
    echo ""
    sleep 1
    # Use exec to replace the menu with bash
    exec bash -l
}

# YOLO Mode - unrestricted Claude session with automatic permission approval.
# Uses command-scoped IS_SANDBOX=1 (not exported) to prevent environment pollution
# and ensure subsequent non-YOLO sessions don't inherit the dangerous flag bypass.
run_claude_yolo() {
    if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
        echo "YOLO Mode: Claude binary not found: $CLAUDE_BIN" >&2
        clear
        echo "❌ Error: Claude binary not found"
        echo ""
        echo "The Claude CLI is not installed or not in your PATH."
        echo "Expected location: $CLAUDE_BIN"
        echo ""
        echo "Try running option 5 (Claude authentication helper) to set up Claude."
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
        return
    fi

    clear
    echo "╔════════════════════════════════════════╗"
    echo "║     ☢️   DANGEROUS MODE (YOLO)  ☢️     ║"
    echo "╚════════════════════════════════════════╝"
    echo ""
    if ! is_yolo_enabled; then
        echo "❌ YOLO mode is disabled by default for safety"
        echo ""
        echo "To enable it explicitly, set: ALLOW_YOLO_MODE=1"
        echo "(e.g. in app configuration/environment)"
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
        return
    fi

    echo "You are about to launch Claude with --dangerously-skip-permissions"
    echo ""
    echo "⚠️  THIS IS EXTREMELY DANGEROUS! ⚠️"
    echo ""
    echo "Dangerous (YOLO) mode allows Claude to:"
    echo "  • DELETE your Home Assistant configuration"
    echo "  • EXPOSE credentials, API keys, and tokens"
    echo "  • MODIFY or DELETE automations without asking"
    echo "  • EXECUTE destructive system commands"
    echo "  • ACCESS and TRANSMIT sensitive data"
    echo ""
    echo "🚨 ONLY use this in isolated test environments!"
    echo "🚨 NEVER use this on production Home Assistant!"
    echo ""
    printf "Type 'YOLO' to confirm (or anything else to cancel): "
    read -r confirmation

    if [ "$confirmation" != "YOLO" ]; then
        echo ""
        echo "❌ YOLO Mode cancelled. Returning to main menu..."
        sleep 2
        return
    fi

    echo ""
    echo "✅ YOLO Mode confirmed!"
    echo ""
    echo "Select session type for YOLO Mode:"
    echo "  1) 🆕 New session"
    echo "  2) ⏩ Continue most recent conversation"
    echo "  3) 📋 Resume from conversation list"
    echo ""
    printf "Enter your choice [1-3] (default: 1): "
    read -r yolo_choice

    if [ -z "$yolo_choice" ]; then
        yolo_choice=1
    fi

    # Reject invalid input instead of silently defaulting
    if [ "$yolo_choice" != "1" ] && [ "$yolo_choice" != "2" ] && [ "$yolo_choice" != "3" ]; then
        echo "YOLO Mode: Invalid session type choice: '$yolo_choice' (expected 1-3)" >&2
        echo ""
        echo "❌ Invalid choice: '$yolo_choice'"
        echo "   Valid options are 1 (New), 2 (Continue), or 3 (Resume)"
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
        return
    fi

    # Launch Claude with IS_SANDBOX scoped to the command (not exported globally)
    local yolo_exit_code
    case "$yolo_choice" in
        1)
            echo "🚀 Starting new YOLO session..."
            sleep 1
            IS_SANDBOX=1 $CLAUDE_BIN --dangerously-skip-permissions
            yolo_exit_code=$?
            ;;
        2)
            echo "⏩ Continuing most recent conversation in YOLO mode..."
            sleep 1
            IS_SANDBOX=1 $CLAUDE_BIN -c --dangerously-skip-permissions
            yolo_exit_code=$?
            ;;
        3)
            echo "📋 Opening conversation list for YOLO mode..."
            sleep 1
            IS_SANDBOX=1 $CLAUDE_BIN -r --dangerously-skip-permissions
            yolo_exit_code=$?
            ;;
    esac

    # Handle Claude exit: 0=success, 1-128=errors, >128=signal exits (e.g. 130=Ctrl+C)
    if [ "$yolo_exit_code" -eq 0 ]; then
        show_return_message
    elif [ "$yolo_exit_code" -gt 128 ] 2>/dev/null; then
        # Signal exit (user interrupted with Ctrl+C, etc.)
        show_return_message
    else
        # Error exit (codes 1-128)
        echo "YOLO Mode: Claude exited with error code: $yolo_exit_code" >&2
        echo ""
        echo "❌ Claude exited with an error (exit code: $yolo_exit_code)"
        case "$yolo_exit_code" in
            1)   echo "   Cause: Authentication failure or general error" ;;
            2)   echo "   Cause: Invalid command-line arguments" ;;
            126) echo "   Cause: Permission denied (cannot execute)" ;;
            127) echo "   Cause: Claude binary not found in PATH" ;;
            *)   echo "   Cause: Unknown error - check Claude logs" ;;
        esac
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
    fi
}

main() {
    while true; do
        show_banner
        show_menu
        choice=$(get_user_choice)

        case "$choice" in
            1)
                run_claude_new
                ;;
            2)
                run_claude_continue
                ;;
            3)
                run_claude_resume
                ;;
            4)
                run_claude_custom
                ;;
            5)
                run_auth_helper
                ;;
            6)
                run_github_auth
                ;;
            7)
                drop_to_bash
                ;;
            8)
                restart_session
                ;;
            9)
                if is_yolo_enabled; then
                    run_claude_yolo
                else
                    echo ""
                    echo "❌ Dangerous mode is disabled (set ALLOW_YOLO_MODE=1 to enable)."
                    echo ""
                    printf "Press Enter to continue..." >&2
                    read -r
                fi
                ;;
            *)
                echo ""
                echo "❌ Invalid choice: '$choice'"
                if is_yolo_enabled; then
                    echo "Please select a number between 1-9"
                else
                    echo "Please select a number between 1-8"
                fi
                echo ""
                printf "Press Enter to continue..." >&2
                read -r
                ;;
        esac
    done
}

# Only start the menu when executed, not when sourced: tests/ sources this
# file to exercise its functions.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    # Handle signals gracefully - prevent accidental exit
    trap 'echo ""; echo "Use option 7 to exit to bash shell."; sleep 2' INT TERM

    main "$@"
fi
