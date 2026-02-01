#!/bin/bash

# Claude Terminal Menu - Interactive menu for Claude session management
# Provides options for new session, continue, resume, custom commands, and tools
#
# With tmux integration, this menu is the "home base" - when Claude exits,
# user returns here to start a new session or access other tools.

# Full path to claude
CLAUDE_BIN="/usr/local/bin/claude"

# Get Claude flags from environment
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
}

get_user_choice() {
    local choice
    printf "Enter your choice [1-8] (default: 1): " >&2
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
    echo "  • Run 'claude' to start a new Claude session"
    echo "  • Run 'claude -c' to continue most recent conversation"
    echo "  • Run 'claude -r' to resume from conversation list"
    echo "  • The menu will not return - this is a permanent shell"
    echo ""
    sleep 1
    # Use exec to replace the menu with bash
    exec bash -l
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
            *)
                echo ""
                echo "❌ Invalid choice: '$choice'"
                echo "Please select a number between 1-8"
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
