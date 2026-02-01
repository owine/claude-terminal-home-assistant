#!/bin/bash

# Claude Session Picker - Interactive menu for choosing Claude session type
# Provides options for new session, continue, resume, manual command, or regular shell
# Now with tmux session persistence for reconnection on navigation

TMUX_SESSION_NAME="claude"

# Get Claude flags from environment
get_claude_flags() {
    local flags=""
    if [ "${CLAUDE_DANGEROUS_MODE}" = "true" ]; then
        flags="--dangerously-skip-permissions"
        echo "⚠️  Running in DANGEROUS mode (unrestricted file access)" >&2
        # Set IS_SANDBOX=1 to allow dangerous mode when running as root
        export IS_SANDBOX=1
    fi
    echo "$flags"
}

show_banner() {
    clear
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    🤖 Claude Terminal                        ║"
    echo "║                   Interactive Session Picker                ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
}

# Check if a tmux session exists and is running
check_existing_session() {
    tmux has-session -t "$TMUX_SESSION_NAME" 2>/dev/null
}

show_menu() {
    echo "Choose your Claude session type:"
    echo ""

    # Show reconnect option if session exists
    if check_existing_session; then
        echo "  0) 🔄 Reconnect to existing session (recommended)"
        echo ""
    fi

    echo "  1) 🆕 New interactive session (default)"
    echo "  2) ⏩ Continue most recent conversation (-c)"
    echo "  3) 📋 Resume from conversation list (-r)"
    echo "  4) ⚙️  Custom Claude command (manual flags)"
    echo "  5) 🔐 Claude authentication helper"
    echo "  6) 🐙 GitHub CLI login (gh auth)"
    echo "  7) 🐚 Drop to bash shell"
    echo "  8) ❌ Exit"
    echo ""
}

get_user_choice() {
    local choice
    local default="1"

    # Default to 0 (reconnect) if session exists
    if check_existing_session; then
        default="0"
    fi

    printf "Enter your choice [0-8] (default: %s): " "$default" >&2
    read -r choice
    

    # Use default if empty
    if [ -z "$choice" ]; then
        choice="$default"
    fi

    # Trim whitespace and return only the choice
    choice=$(echo "$choice" | tr -d '[:space:]')
    echo "$choice"
}

# Attach to existing tmux session
attach_existing_session() {
    echo "🔄 Reconnecting to existing Claude session..."
    sleep 1
    exec tmux attach-session -t "$TMUX_SESSION_NAME"
}

# Full path to claude (tmux doesn't inherit PATH)
CLAUDE_BIN="/usr/local/bin/claude"

# Start claude in a new tmux session (kills existing if any)
launch_claude_new() {
    local flags=$(get_claude_flags)
    echo "🚀 Starting new Claude session..."

    # Kill existing session if present
    if check_existing_session; then
        echo "   (closing previous session)"
        tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null
    fi

    sleep 1
    if [ -n "$flags" ]; then
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- $CLAUDE_BIN $flags
    else
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- $CLAUDE_BIN
    fi
}

launch_claude_continue() {
    local flags=$(get_claude_flags)
    echo "⏩ Continuing most recent conversation..."

    if check_existing_session; then
        tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null
    fi

    sleep 1
    if [ -n "$flags" ]; then
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- $CLAUDE_BIN -c $flags
    else
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- $CLAUDE_BIN -c
    fi
}

launch_claude_resume() {
    local flags=$(get_claude_flags)
    echo "📋 Opening conversation list for selection..."

    if check_existing_session; then
        tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null
    fi

    sleep 1
    if [ -n "$flags" ]; then
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- $CLAUDE_BIN -r $flags
    else
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- $CLAUDE_BIN -r
    fi
}

launch_claude_custom() {
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
        launch_claude_new
    else
        echo "🚀 Running: claude $custom_args $base_flags"

        if check_existing_session; then
            tmux kill-session -t "$TMUX_SESSION_NAME" 2>/dev/null
        fi

        sleep 1
        # Use bash -c for custom args to handle quoted strings properly
        exec tmux new-session -s "$TMUX_SESSION_NAME" -- bash -c "$CLAUDE_BIN $custom_args $base_flags"
    fi
}

launch_auth_helper() {
    echo "🔐 Starting Claude authentication helper..."
    sleep 1
    exec /opt/scripts/claude-auth-helper.sh
}

launch_github_auth() {
    echo ""
    echo "🐙 GitHub CLI Authentication"
    echo "════════════════════════════"
    echo ""

    # Check if gh is installed
    if ! command -v gh &>/dev/null; then
        echo "❌ GitHub CLI (gh) is not installed!"
        echo "   Update to Claude Terminal Pro v2.0.4+ to get gh pre-installed."
        echo ""
        printf "Press Enter to return to menu..." >&2
        read -r
        return
    fi

    # Check current auth status
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
        gh auth login --with-token <<< "$(read -rsp 'Paste your token: ' token; echo "$token")" 2>/dev/null || {
            # Fallback to interactive if the above fails
            echo ""
            gh auth login -p https -h github.com
        }
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

launch_bash_shell() {
    echo "🐚 Dropping to bash shell..."
    echo "Tip: Run 'tmux new-session -A -s claude \"claude\"' to start with persistence"
    sleep 1
    exec bash
}

exit_session_picker() {
    echo "👋 Goodbye!"
    exit 0
}

# Main execution flow
main() {
    while true; do
        show_banner
        show_menu
        choice=$(get_user_choice)

        case "$choice" in
            0)
                if check_existing_session; then
                    attach_existing_session
                else
                    echo "❌ No existing session found"
                    sleep 1
                fi
                ;;
            1)
                launch_claude_new
                ;;
            2)
                launch_claude_continue
                ;;
            3)
                launch_claude_resume
                ;;
            4)
                launch_claude_custom
                ;;
            5)
                launch_auth_helper
                ;;
            6)
                launch_github_auth
                ;;
            7)
                launch_bash_shell
                ;;
            8)
                exit_session_picker
                ;;
            *)
                echo ""
                echo "❌ Invalid choice: '$choice'"
                echo "Please select a number between 0-8"
                echo ""
                printf "Press Enter to continue..." >&2
                read -r
                ;;
        esac
    done
}

# Handle cleanup on exit - don't kill tmux session, just exit picker
trap 'echo ""; exit 0' EXIT INT TERM

# Run main function
main "$@"