#!/bin/bash

# Claude Terminal Menu - Interactive menu for Claude session management
# Provides options for new session, continue, resume, custom commands, and tools
#
# With tmux integration, this menu is the "home base" - when Claude exits,
# user returns here to start a new session or access other tools.

# Claude binary (now in PATH via /root/.local/bin)
CLAUDE_BIN="claude"

# Get Claude flags from environment.
# Checks CLAUDE_DANGEROUS_MODE config to determine if unrestricted mode is enabled.
# When enabled, sets IS_SANDBOX=1 which is required by Claude CLI to accept
# --dangerously-skip-permissions when running as root (container security context).
# Without IS_SANDBOX=1, Claude CLI refuses the dangerous flag for safety.
#
# NOTE: In run_claude_yolo(), IS_SANDBOX is command-scoped (not exported) to
# prevent it from leaking into subsequent non-YOLO sessions.
get_claude_flags() {
    local flags=""
    if [ "${CLAUDE_DANGEROUS_MODE}" = "true" ]; then
        flags="--dangerously-skip-permissions"
        echo "⚠️  Running in DANGEROUS mode (unrestricted file access)" >&2
        export IS_SANDBOX=1
    fi
    echo "$flags"
}

show_banner() {
    clear
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                    🤖 Claude Terminal                      ║"
    echo "║                          Menu                              ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
}

show_menu() {
    echo "Choose your Claude session type:"
    echo ""
    echo "  1) 🆕 New interactive session (default)"
    echo "  2) ⏩ Continue most recent conversation (-c)"
    echo "  3) 📋 Resume from conversation list (-r)"
    echo "  4) ⚙️  Custom Claude command (manual flags)"
    echo "  5) 🔐 Claude authentication helper"
    echo "  6) 🐙 GitHub CLI login (gh auth)"
    echo "  7) 🐚 Drop to bash shell (exit menu)"
    echo "  8) 🔄 Clear & restart session (reset scrollback)"
    echo ""
    echo "  ─────────────────────────────────────"
    echo "  9) ⚠️  YOLO Mode (skip all permissions)"
}

get_user_choice() {
    local choice
    printf "Enter your choice [1-9] (default: 1): " >&2
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
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Claude session ended. Returning to menu..."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    sleep 2
}

# Run Claude and return to picker when done (no exec)
run_claude_new() {
    local flags=$(get_claude_flags)
    echo "🚀 Starting new Claude session..."
    sleep 1
    if [ -n "$flags" ]; then
        $CLAUDE_BIN $flags
    else
        $CLAUDE_BIN
    fi
    show_return_message
}

run_claude_continue() {
    local flags=$(get_claude_flags)
    echo "⏩ Continuing most recent conversation..."
    sleep 1
    if [ -n "$flags" ]; then
        $CLAUDE_BIN -c $flags
    else
        $CLAUDE_BIN -c
    fi
    show_return_message
}

run_claude_resume() {
    local flags=$(get_claude_flags)
    echo "📋 Opening conversation list for selection..."
    sleep 1
    if [ -n "$flags" ]; then
        $CLAUDE_BIN -r $flags
    else
        $CLAUDE_BIN -r
    fi
    show_return_message
}

run_claude_custom() {
    local base_flags=$(get_claude_flags)
    echo ""
    echo "Enter your Claude command (e.g., 'claude --help' or 'claude -p \"hello\"'):"
    echo "Available flags: -c (continue), -r (resume), -p (print), --model,"
    echo "                 --dangerously-skip-permissions, etc."
    if [ "${CLAUDE_DANGEROUS_MODE}" = "true" ]; then
        echo "Note: --dangerously-skip-permissions will be automatically added"
    fi
    echo -n "> claude "
    read -r custom_args

    if [ -z "$custom_args" ]; then
        echo "No arguments provided. Starting default session..."
        run_claude_new
    else
        echo "🚀 Running: claude $custom_args $base_flags"
        sleep 1
        eval "$CLAUDE_BIN $custom_args $base_flags"
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
    echo "🐙 GitHub CLI Authentication"
    echo "════════════════════════════"
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

# YOLO Mode - run Claude with --dangerously-skip-permissions
run_claude_yolo() {
    # Pre-flight check: verify Claude binary is available before showing prompts
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
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║                  ⚠️  YOLO MODE WARNING ⚠️                    ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "You are about to launch Claude with --dangerously-skip-permissions"
    echo ""
    echo "This mode will:"
    echo "  • Skip ALL permission prompts automatically"
    echo "  • Allow Claude to execute ANY command without confirmation"
    echo "  • Allow Claude to read/write ANY file without asking"
    echo "  • Allow Claude to make network requests freely"
    echo ""
    echo "⚠️  THIS IS DANGEROUS! Only use if you understand the risks."
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

    # Default to 1 if empty
    if [ -z "$yolo_choice" ]; then
        yolo_choice=1
    fi

    # Validate choice - return to main menu on invalid input to ensure users
    # get exactly the session type they requested rather than silently defaulting.
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

    # Handle Claude exit: codes 1-126 indicate errors, >128 are signal exits (e.g. Ctrl+C)
    if [ "$yolo_exit_code" -gt 0 ] 2>/dev/null && [ "$yolo_exit_code" -le 126 ]; then
        echo "YOLO Mode: Claude exited with error code: $yolo_exit_code" >&2
        echo ""
        echo "❌ Claude exited with an error (exit code: $yolo_exit_code)"
        echo "   Common causes: missing credentials, low memory, corrupted config"
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
    else
        show_return_message
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
                run_claude_yolo
                ;;
            *)
                echo ""
                echo "❌ Invalid choice: '$choice'"
                echo "Please select a number between 1-9"
                echo ""
                printf "Press Enter to continue..." >&2
                read -r
                ;;
        esac
    done
}

# Handle signals gracefully - prevent accidental exit
trap 'echo ""; echo "Use option 7 to exit to bash shell."; sleep 2' INT TERM

main "$@"
