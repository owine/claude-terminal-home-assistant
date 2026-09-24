#!/usr/bin/with-contenv bashio

# Enable strict error handling
set -e
set -o pipefail

# Initialize environment for Claude Code CLI using /data (HA best practice)
init_environment() {
    # Use /data exclusively - guaranteed writable by HA Supervisor
    local data_home="/data/home"
    local config_dir="/data/.config"
    local cache_dir="/data/.cache"
    local state_dir="/data/.local/state"
    local claude_config_dir="/data/.config/claude"
    local gh_config_dir="/data/.config/gh"
    local persist_root="/data/packages"
    local persist_bin="$persist_root/bin"
    local persist_lib="$persist_root/lib"
    local persist_libexec="$persist_root/libexec"
    local persist_python="$persist_root/python"

    bashio::log.info "Initializing Claude Code environment in /data..."

    # Create all required directories
    if ! mkdir -p "$data_home" "$data_home/.local/bin" "$config_dir/claude" "$config_dir/gh" "$cache_dir" "$state_dir" "/data/.local" \
                  "$persist_bin" "$persist_lib" "$persist_libexec" "$persist_python"; then
        bashio::log.error "Failed to create directories in /data"
        exit 1
    fi

    # Set permissions
    chmod 755 "$data_home" "$config_dir" "$cache_dir" "$state_dir" "$claude_config_dir" "$gh_config_dir" \
              "$persist_root" "$persist_bin" "$persist_lib" "$persist_libexec" "$persist_python"

    # Set XDG and application environment variables
    export HOME="$data_home"
    export XDG_CONFIG_HOME="$config_dir"
    export XDG_CACHE_HOME="$cache_dir"
    export XDG_STATE_HOME="$state_dir"
    export XDG_DATA_HOME="/data/.local/share"

    # Claude-specific environment variables
    export ANTHROPIC_CONFIG_DIR="$claude_config_dir"
    export ANTHROPIC_HOME="/data"

    # GitHub CLI persistent configuration
    export GH_CONFIG_DIR="$gh_config_dir"

    # Get dangerously-skip-permissions configuration
    local dangerously_skip_permissions
    dangerously_skip_permissions=$(bashio::config 'dangerously_skip_permissions' 'false')
    export CLAUDE_DANGEROUS_MODE="$dangerously_skip_permissions"

    # Wire app configuration to session-picker dangerous mode gate
    if [ "$dangerously_skip_permissions" = "true" ]; then
        export ALLOW_YOLO_MODE=1
    else
        export ALLOW_YOLO_MODE=0
    fi

    # Set IS_SANDBOX=1 to allow --dangerously-skip-permissions when running as root
    if [ "$dangerously_skip_permissions" = "true" ]; then
        export IS_SANDBOX=1
    fi

    # Configure npm cache location. By default the cache is ephemeral (/tmp) so
    # it never accumulates in persistent /data storage, where it would bloat
    # every HA backup (see issue heytcass/home-assistant-addons#103). Opting into
    # persist_npm_cache restores the legacy $HOME/.npm behavior.
    local persist_npm_cache
    persist_npm_cache=$(bashio::config 'persist_npm_cache' 'false')
    if [ "$persist_npm_cache" = "true" ]; then
        # Legacy behavior: npm uses its default cache at $HOME/.npm (persisted).
        unset npm_config_cache
        bashio::log.info "  - npm cache: persistent ($data_home/.npm)"
    else
        # Ephemeral cache in /tmp keeps it out of /data (and HA backups).
        export npm_config_cache="/tmp/npm-cache"
        mkdir -p "$npm_config_cache"
        # Reclaim any legacy cache accumulated in persistent storage by earlier
        # versions, shrinking existing backups on the next run. ${data_home:?}
        # guards against ever running rm against a bare "/.npm" if the path were
        # somehow unset.
        if [ -d "$data_home/.npm" ]; then
            bashio::log.info "  - npm cache: reclaiming legacy cache at $data_home/.npm"
            rm -rf "${data_home:?}/.npm"
        fi
        bashio::log.info "  - npm cache: ephemeral ($npm_config_cache)"
    fi

    # Same class of backup bloat as the npm cache above, different directory:
    # superseded Claude Code binaries accumulate in versions/. XDG_DATA_HOME
    # and HOME are both exported by this point.
    prune_claude_versions

    # Setup persistent package paths (HIGHEST PRIORITY)
    # Include $HOME/.local/bin for Claude Code native components
    export PATH="$persist_bin:$persist_python/venv/bin:$HOME/.local/bin:$PATH"
    export LD_LIBRARY_PATH="$persist_lib:${LD_LIBRARY_PATH:-}"
    export PKG_CONFIG_PATH="$persist_lib/pkgconfig:${PKG_CONFIG_PATH:-}"

    # Python virtual environment if it exists
    if [ -d "$persist_python/venv" ]; then
        export VIRTUAL_ENV="$persist_python/venv"
        bashio::log.info "  - Python venv: active"
    fi

    # bin and lib are reached through PATH and LD_LIBRARY_PATH, which are now
    # set. libexec cannot be: it has to be copied back onto the freshly rebuilt
    # container filesystem before anything looks for a helper there.
    restore_persistent_libexec

    # Create profile script for persistent environment variables
    # This ensures ALL bash sessions (including ttyd shells) have correct PATH
    cat > /etc/profile.d/persistent-packages.sh << 'PROFILE_EOF'
# Persistent package environment - auto-loaded for all bash sessions
export HOME="/data/home"
export XDG_CONFIG_HOME="/data/.config"
export XDG_CACHE_HOME="/data/.cache"
export XDG_STATE_HOME="/data/.local/state"
export XDG_DATA_HOME="/data/.local/share"
export ANTHROPIC_CONFIG_DIR="/data/.config/claude"
export ANTHROPIC_HOME="/data"

# GitHub CLI persistent configuration
export GH_CONFIG_DIR="/data/.config/gh"

# Claude Code deliberately keeps its own mouse tracking (it asks for ?1000h +
# ?1006h, press/release with SGR, which includes wheel events). There used to be
# a CLAUDE_CODE_DISABLE_MOUSE=1 here; removing it is what makes the wheel scroll
# the Claude Code session instead of tmux's pane history.
#
# tmux ORs an application's mouse request into the outer terminal's mode and its
# WheelUpPane binding forwards the wheel to the application whenever
# mouse_any_flag is set. So the wheel lands wherever it should without anything
# having to detect which program is running: inside Claude Code it scrolls the
# session, and at a shell prompt - where nothing has claimed the mouse - tmux
# takes it and scrolls history.
#
# Disabling it was originally defense in depth for the DECSET veto, which no
# longer exists. Handing an application the mouse is safe now because text
# selection no longer depends on denying it: Shift+drag (Option on macOS) forces
# xterm's own selection whatever holds mouse reporting.

# Persistent package paths (HIGHEST PRIORITY)
# Include $HOME/.local/bin for Claude Code native components
export PATH="/data/packages/bin:/data/packages/python/venv/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="/data/packages/lib:${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="/data/packages/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

# Python virtual environment if it exists
if [ -d "/data/packages/python/venv" ]; then
    export VIRTUAL_ENV="/data/packages/python/venv"
fi

# Convenience alias to return to menu from bash shell
alias menu='/usr/local/bin/claude-session-picker'
PROFILE_EOF

    # Mirror the ephemeral npm cache into interactive shells (ttyd sessions).
    # The heredoc above rewrites this file with `>` (truncate) on every startup,
    # so this appends exactly one line to a freshly written file - it never
    # accumulates across restarts. In persistent mode npm falls back to its
    # $HOME/.npm default, so nothing extra is needed there.
    if [ "$persist_npm_cache" != "true" ]; then
        echo 'export npm_config_cache="/tmp/npm-cache"' >> /etc/profile.d/persistent-packages.sh
    fi

    chmod 644 /etc/profile.d/persistent-packages.sh
    bashio::log.info "  - Profile script created: /etc/profile.d/persistent-packages.sh"

    # Migrate any existing authentication files from legacy locations
    migrate_legacy_auth_files "$claude_config_dir"

    # Install tmux configuration to user home directory
    if [ -f "/opt/scripts/tmux.conf" ]; then
        cp /opt/scripts/tmux.conf "$data_home/.tmux.conf"
        chmod 644 "$data_home/.tmux.conf"

        # Apply tmux mouse mode setting from configuration
        local tmux_mouse_mode
        tmux_mouse_mode=$(bashio::config 'tmux_mouse_mode' 'true')

        # Only an explicit "false" disables it. Testing for "true" instead would
        # silently disable the mouse whenever bashio::config returns nothing --
        # which is exactly what happens when the Supervisor API is unreachable,
        # and it produced a container with mouse off despite the default being
        # on. The safe direction for a missing value is the documented default.
        if [ "$tmux_mouse_mode" = "false" ]; then
            sed -i 's/set -g mouse on/set -g mouse off/' "$data_home/.tmux.conf"
            bashio::log.info "  - tmux mouse mode: disabled (no wheel scrolling; Ctrl+B, [ to scroll)"
        else
            sed -i 's/set -g mouse off/set -g mouse on/' "$data_home/.tmux.conf"
            bashio::log.info "  - tmux mouse mode: enabled (wheel scrolls, drag copies; Shift/Option+drag for terminal selection)"
        fi

        bashio::log.info "  - tmux configuration installed"
    fi

    # Setup Claude Code skills and commands
    if [ -d "/opt/.claude" ]; then
        if [ ! -d "$data_home/.claude" ]; then
            cp -r /opt/.claude "$data_home/.claude"
            bashio::log.info "  - Claude Code skills & commands installed"
        else
            bashio::log.info "  - Claude Code skills & commands: already configured"
        fi
    fi

    # Copy Claude binary to persistent home directory if not present
    # This ensures Claude is in $HOME/.local/bin (already in PATH)
    if [ -f "/root/.local/bin/claude" ] && [ ! -f "$data_home/.local/bin/claude" ]; then
        mkdir -p "$data_home/.local/bin"
        cp /root/.local/bin/claude "$data_home/.local/bin/claude"
        chmod +x "$data_home/.local/bin/claude"
        bashio::log.info "  - Claude binary installed to persistent home"
    fi

    bashio::log.info "Environment initialized:"
    bashio::log.info "  - Home: $HOME"
    bashio::log.info "  - Config: $XDG_CONFIG_HOME"
    bashio::log.info "  - Claude config: $ANTHROPIC_CONFIG_DIR"
    bashio::log.info "  - GitHub config: $GH_CONFIG_DIR"
    bashio::log.info "  - Cache: $XDG_CACHE_HOME"
    bashio::log.info "  - Persistent packages: $persist_root"
}

# Put persisted libexec helpers back where their programs look for them.
#
# /data/packages/bin and /data/packages/lib work by being prepended to PATH and
# LD_LIBRARY_PATH. libexec has no such variable: whatever uses a helper there
# looks in a fixed absolute location - Docker finds `docker compose` at
# /usr/libexec/docker/cli-plugins/docker-compose, git finds its helpers under
# /usr/libexec/git-core - and that location lives on the container filesystem,
# which is rebuilt on every restart. So the files have to be copied back.
#
# An existing target is never overwritten. /data outlives the image, so a helper
# persisted against an older Alpine must not replace the one the current image
# shipped - the same hazard as a stale credential in the legacy auth migration,
# or a stale .so ahead of the system one on LD_LIBRARY_PATH. The image always
# wins; persistence only fills gaps.
#
# PERSIST_LIBEXEC_DIR and LIBEXEC_TARGET_DIR are test seams with production
# defaults.
restore_persistent_libexec() {
    local source_root="${PERSIST_LIBEXEC_DIR:-/data/packages/libexec}"
    local target_root="${LIBEXEC_TARGET_DIR:-/usr/libexec}"

    [ -d "$source_root" ] || return 0

    local source relative target restored=0
    # -type f only: directories are created on demand below, and a dangling
    # symlink persisted from an older image would restore nothing useful.
    while IFS= read -r source; do
        [ -n "$source" ] || continue
        relative="${source#"$source_root"/}"
        target="$target_root/$relative"

        # The image's own copy wins.
        [ -e "$target" ] && continue

        mkdir -p "$(dirname "$target")" || continue
        # -a preserves the executable bit, without which Docker skips a plugin
        # silently - indistinguishable from it not being installed.
        cp -a "$source" "$target" 2>/dev/null && restored=$((restored + 1))
    done <<EOF
$(find "$source_root" -type f 2>/dev/null)
EOF

    if [ "$restored" -gt 0 ]; then
        bashio::log.info "  - Persistent packages: restored $restored libexec helper(s)"
    fi
}

# Reclaim persistent storage taken by superseded Claude Code binaries.
#
# The native CLI self-updates through its own path regardless of any add-on
# setting (autoUpdatesProtectedForNative exempts native installs from the
# autoUpdates toggle), leaving a ~250 MB binary behind in versions/ on every
# update. XDG_DATA_HOME points into /data, so each one is dead weight carried
# into every Home Assistant backup from then on - the same failure mode as the
# legacy npm cache handled above.
#
# Keep two entries: whatever the active symlink resolves to, and the newest
# entry (so a rollback target survives). Prune the rest. A pruned binary that
# is mid-execution keeps running - the inode stays alive until the process
# exits - so no running-session check is needed.
prune_claude_versions() {
    local versions_dir="${XDG_DATA_HOME:?}/claude/versions"
    [ -d "$versions_dir" ] || return 0

    local active newest entry canonical pruned=0
    # Both sides of the comparison are canonicalized. readlink -f resolves every
    # component, so comparing its output against a raw "$versions_dir/*" path
    # silently fails to match whenever any parent component is itself a symlink
    # - and a missed match here deletes the binary that is actually in use.
    active=$(readlink -f "$HOME/.local/bin/claude" 2>/dev/null || true)
    # busybox-safe newest-entry lookup: find -printf is not available here, and
    # version directory names are semver (no whitespace or globs to mangle).
    # shellcheck disable=SC2012  # ls is safe for these controlled names
    newest=$(readlink -f "$versions_dir/$(ls -1t "$versions_dir" 2>/dev/null | head -1)" 2>/dev/null || true)

    for entry in "$versions_dir"/*; do
        [ -e "$entry" ] || continue
        canonical=$(readlink -f "$entry" 2>/dev/null || echo "$entry")
        [ -n "$active" ] && [ "$canonical" = "$active" ] && continue
        [ -n "$newest" ] && [ "$canonical" = "$newest" ] && continue
        rm -rf "$entry"
        pruned=$((pruned + 1))
    done

    if [ "$pruned" -gt 0 ]; then
        bashio::log.info "  - Claude versions: pruned $pruned superseded binary/binaries from /data"
    fi
}

# One-time migration of existing authentication files.
#
# "One-time" is enforced by a marker listing the sources already migrated. It
# used to be enforced only by the /root branch below replacing its source with
# a symlink, which left /config/claude-config and /tmp/claude-config copying on
# EVERY boot: a user who logged in again after the migration had the stale
# credential in /config put back over the fresh one on the next restart.
#
# The marker records each source path rather than a single "migration ran"
# flag, so a legacy directory that only appears later is still picked up.
migrate_legacy_auth_files() {
    local target_dir="$1"
    local migrated=false
    # Lives in the target dir, which is /data and therefore survives restarts
    # alongside the credentials whose re-copying it is there to prevent.
    local marker="$target_dir/.legacy-auth-migrated"

    bashio::log.info "Checking for existing authentication files to migrate..."

    # Check common legacy locations. LEGACY_AUTH_PREFIX is a test seam and is
    # empty in production, mirroring CLAUDE_BIN_PREFIX in health-check.sh: these
    # paths are absolute and cannot otherwise be pointed at a fixture tree.
    local prefix="${LEGACY_AUTH_PREFIX:-}"
    local legacy_locations=(
        "$prefix/root/.config/anthropic"
        "$prefix/root/.anthropic"
        "$prefix/config/claude-config"
        "$prefix/tmp/claude-config"
    )

    for legacy_path in "${legacy_locations[@]}"; do
        if [ -d "$legacy_path" ] && [ "$(ls -A "$legacy_path" 2>/dev/null)" ]; then
            # Already carried over on an earlier boot. Skipping is the whole
            # point: the source is left in place for the user to inspect and
            # remove, so it is still here and still looks migratable.
            if grep -qxF -- "$legacy_path" "$marker" 2>/dev/null; then
                bashio::log.debug "Already migrated, skipping: $legacy_path"
                continue
            fi

            bashio::log.info "Migrating auth files from: $legacy_path"

            # "$legacy_path/." rather than "$legacy_path"/* - the glob skips
            # dotfiles, and every file this migration exists to move is one
            # (.credentials.json, .claude.json). With the glob it matched
            # nothing, cp was handed the literal unexpanded pattern, and the
            # failure was swallowed by 2>/dev/null.
            if cp -a "$legacy_path/." "$target_dir/" 2>/dev/null; then
                # Set proper permissions
                find "$target_dir" -type f -exec chmod 600 {} \;

                # Create compatibility symlink if this is a standard location
                if [[ "$legacy_path" == "$prefix/root/.config/anthropic" ]] || [[ "$legacy_path" == "$prefix/root/.anthropic" ]]; then
                    rm -rf "$legacy_path"
                    ln -sf "$target_dir" "$legacy_path"
                    bashio::log.info "Created compatibility symlink: $legacy_path -> $target_dir"
                fi

                # Record the source only after a successful copy, so a failed
                # migration is retried on the next boot rather than skipped.
                printf '%s\n' "$legacy_path" >> "$marker"
                chmod 600 "$marker" 2>/dev/null || true

                migrated=true
                bashio::log.info "Migration completed from: $legacy_path"
                bashio::log.info "You can now delete $legacy_path"
            else
                bashio::log.warning "Failed to migrate from: $legacy_path"
            fi
        fi
    done

    if [ "$migrated" = false ]; then
        bashio::log.info "No existing authentication files found to migrate"
    fi
}

# Setup session picker script
setup_session_picker() {
    # Copy session picker script from built-in location
    if [ -f "/opt/scripts/claude-session-picker.sh" ]; then
        if ! cp /opt/scripts/claude-session-picker.sh /usr/local/bin/claude-session-picker; then
            bashio::log.error "Failed to copy claude-session-picker script"
            exit 1
        fi
        chmod +x /usr/local/bin/claude-session-picker
        bashio::log.info "Session picker script installed successfully"
    else
        bashio::log.warning "Session picker script not found, using auto-launch mode only"
    fi

    # Setup authentication helper if it exists
    if [ -f "/opt/scripts/claude-auth-helper.sh" ]; then
        chmod +x /opt/scripts/claude-auth-helper.sh
        bashio::log.info "Authentication helper script ready"
    fi

    # Expose the health check as a user-facing diagnostic. It already runs once
    # at boot into the add-on log, which is not where a user looks when the
    # terminal misbehaves - they are in the terminal. A symlink rather than a
    # copy so the two can never drift.
    if [ -f "/opt/scripts/health-check.sh" ]; then
        chmod +x /opt/scripts/health-check.sh
        ln -sf /opt/scripts/health-check.sh /usr/local/bin/claude-doctor
        bashio::log.info "Diagnostic command installed: 'claude-doctor'"
    fi
}

# Setup persistent package manager
setup_persistent_packages() {
    # Install persist-install command globally
    if [ -f "/opt/scripts/persist-install" ]; then
        cp /opt/scripts/persist-install /usr/local/bin/persist-install
        chmod +x /usr/local/bin/persist-install
        bashio::log.info "Persistent package manager installed: 'persist-install'"
    fi

    # Auto-install packages from configuration
    auto_install_packages
}

# Auto-install packages from app configuration
auto_install_packages() {
    local options="/data/options.json"
    local apk_count=0
    local pip_count=0

    # Read /data/options.json directly — bashio::config mangles list types
    # through shell variable assignment, making them unparseable as JSON.
    if [ ! -f "$options" ]; then
        bashio::log.debug "No options.json found — skipping package auto-install"
        return 0
    fi

    apk_count=$(jq -r '.persistent_apk_packages | if type == "array" then length else 0 end' "$options" 2>/dev/null) || apk_count=0
    pip_count=$(jq -r '.persistent_pip_packages | if type == "array" then length else 0 end' "$options" 2>/dev/null) || pip_count=0

    # Install APK packages if configured
    if [ "$apk_count" -gt 0 ] 2>/dev/null; then
        bashio::log.info "Auto-installing ${apk_count} system package(s) from config..."

        jq -r '.persistent_apk_packages[]' "$options" 2>/dev/null | while read -r pkg; do
            if [ -n "$pkg" ]; then
                bashio::log.info "  Installing: $pkg"
                /usr/local/bin/persist-install "$pkg" || bashio::log.warning "Failed to install: $pkg"
            fi
        done || true
    fi

    # Install Python packages if configured
    if [ "$pip_count" -gt 0 ] 2>/dev/null; then
        bashio::log.info "Auto-installing ${pip_count} Python package(s) from config..."

        local all_packages
        all_packages=$(jq -r '.persistent_pip_packages[]' "$options" 2>/dev/null | tr '\n' ' ') || true

        if [ -n "$all_packages" ]; then
            bashio::log.info "  Installing: $all_packages"
            # Intentional word splitting: each package is a separate argument
            # shellcheck disable=SC2086
            /usr/local/bin/persist-install --python $all_packages || bashio::log.warning "Failed to install Python packages"
        fi
    fi
}

# Optional Docker CLI support.
# Installs docker-cli (+ compose, optional buildx) via persist-install and
# validates access to the host Docker socket. Requires Protection Mode OFF.
# Never aborts startup — all failures degrade to warnings.
init_docker() {
    local enable_docker enable_buildx
    enable_docker=$(bashio::config 'enable_docker' 'false')

    if [ "$enable_docker" != "true" ]; then
        return 0
    fi

    bashio::log.info "Docker support enabled — installing Docker CLI..."

    local packages="docker-cli docker-cli-compose"
    enable_buildx=$(bashio::config 'enable_docker_buildx' 'false')
    if [ "$enable_buildx" = "true" ]; then
        packages="$packages docker-cli-buildx"
    fi

    # shellcheck disable=SC2086  # word-splitting is intentional for the package list
    if ! /usr/local/bin/persist-install $packages; then
        bashio::log.warning "Failed to install Docker CLI packages; 'docker' may be unavailable"
        return 0
    fi

    # Validate socket presence (mounted by docker_api when Protection Mode is OFF).
    if [ ! -S "/run/docker.sock" ]; then
        bashio::log.warning "Docker socket /run/docker.sock not found."
        bashio::log.warning "Disable Protection Mode in the add-on's Info tab to enable Docker access."
        return 0
    fi

    # Docker is active — surface the security implications now that it can actually be used.
    bashio::log.warning "SECURITY: Docker socket access grants effectively ROOT on the host."
    bashio::log.warning "SECURITY: Only keep enable_docker on if you understand this risk."

    # Confirm daemon connectivity (lightweight).
    # Bounded: a wedged daemon can accept the connection and never answer,
    # and startup waits on this.
    if timeout 10 docker version >/dev/null 2>&1; then
        bashio::log.info "Docker CLI ready and connected to the host daemon."
    else
        bashio::log.warning "Docker socket present but daemon unreachable ('docker version' failed)."
    fi
}

# Legacy monitoring functions removed - using simplified /data approach

# Non-interactive authentication via a token from `claude setup-token`.
#
# The value reaches the auto-launched claude through the environment: run.sh
# starts the tmux server, so every session and pane inherits this export, and
# tmux.conf lists CLAUDE_CODE_OAUTH_TOKEN in update-environment so re-attached
# clients keep it. It deliberately does NOT go into
# /etc/profile.d/persistent-packages.sh - that file lives on disk and would put
# a long-lived credential somewhere it can be read back, and the tmux session
# command runs through a non-interactive shell that never sources it anyway.
#
# The token itself is never logged. It is declared password? in the schema so
# the Supervisor UI masks it.
#
# Note: token auth cannot establish Remote Control sessions.
export_oauth_token() {
    local token
    token=$(bashio::config 'claude_code_oauth_token' '')

    if [ -n "$token" ] && [ "$token" != "null" ]; then
        export CLAUDE_CODE_OAUTH_TOKEN="$token"
        bashio::log.info "CLAUDE_CODE_OAUTH_TOKEN set from add-on configuration"
    fi
}

# Directory the terminal session starts in.
#
# Defaults to /config, which is what the container already used: the Dockerfile
# sets WORKDIR /config, so run.sh - and therefore the tmux server and every
# session it spawns - inherits it. Keeping /config as the default makes this
# option a no-op for anyone who does not set it.
#
# A configured directory that does not exist warns and falls back rather than
# failing: a typo in an add-on option must never take the terminal down, since
# the terminal is how the user would fix the typo. Claude Code shows its
# one-time per-directory trust prompt on first use of a new directory.
get_working_directory() {
    local dir
    dir=$(bashio::config 'working_directory' '')

    if [ -z "$dir" ] || [ "$dir" = "null" ]; then
        echo "/config"
        return 0
    fi

    if [ -d "$dir" ]; then
        echo "$dir"
    else
        bashio::log.warning "working_directory '$dir' does not exist; starting in /config instead"
        echo "/config"
    fi
}

# Determine Claude launch command based on configuration
get_claude_launch_command() {
    local auto_launch_claude
    local dangerously_skip_permissions
    local claude_flags=""

    # Get configuration values
    auto_launch_claude=$(bashio::config 'auto_launch_claude' 'true')
    dangerously_skip_permissions=$(bashio::config 'dangerously_skip_permissions' 'false')

    # Build Claude flags
    if [ "$dangerously_skip_permissions" = "true" ]; then
        claude_flags="--dangerously-skip-permissions"
        bashio::log.warning "Claude will run with --dangerously-skip-permissions (unrestricted file access)"
    fi

    if [ "$auto_launch_claude" = "true" ]; then
        # Auto-launch Claude directly
        if [ -n "$claude_flags" ]; then
            echo "clear && echo 'Welcome to Claude Terminal!' && echo '' && echo 'Starting Claude...' && sleep 1 && claude $claude_flags"
        else
            echo "clear && echo 'Welcome to Claude Terminal!' && echo '' && echo 'Starting Claude...' && sleep 1 && claude"
        fi
    else
        # Show interactive session picker
        if [ -f /usr/local/bin/claude-session-picker ]; then
            echo "clear && /usr/local/bin/claude-session-picker"
        else
            # Fallback if session picker is missing
            bashio::log.warning "Session picker not found, falling back to auto-launch"
            echo "clear && echo 'Welcome to Claude Terminal!' && echo '' && echo 'Starting Claude...' && sleep 1 && claude"
        fi
    fi
}


# prune_uploaded_images [dir]
#
# Delete pasted/dropped images older than the image_retention_days option
# (default 30; 0 keeps them all). Nothing else ever removed them, and /data is
# in every Home Assistant backup, so the folder grew those without bound.
#
# Only the wrapper's own `pasted-*` files are candidates - anything a user put
# in the folder is left alone. A value that is not a whole number deletes
# nothing: guessing wrong here is the one mistake that cannot be undone.
prune_uploaded_images() {
    local dir="${1:-/data/images}"
    local days
    days=$(bashio::config 'image_retention_days' '30')

    # bashio::config yields "" rather than the default when the Supervisor API
    # is unreachable. For every other option the safe reading of a missing
    # value is its default; for a deletion it is "delete nothing".
    case "$days" in
        '')
            bashio::log.info "image_retention_days could not be read; keeping all uploads this boot"
            return 0
            ;;
        *[!0-9]*)
            bashio::log.warning "image_retention_days is not a whole number (${days}); keeping all uploads"
            return 0
            ;;
    esac
    if [ "$days" -eq 0 ] || [ ! -d "$dir" ]; then
        return 0
    fi

    # -mmin rather than -mtime: -mtime counts whole 24h periods and rounds,
    # which makes "older than N days" off by up to a day.
    local removed
    removed=$(find "$dir" -maxdepth 1 -type f -name 'pasted-*' -mmin +$((days * 1440)) -print -delete | wc -l | tr -d ' ')
    if [ "$removed" -gt 0 ]; then
        bashio::log.info "Uploaded images: removed ${removed} older than ${days} day(s) from ${dir}"
    fi
}

# Start wrapper service (UI, terminal proxy, image uploads, clipboard delivery)
start_wrapper_service() {
    local wrapper_port=7680
    local ttyd_port=7681
    local upload_dir="/data/images"
    local service_dir="/opt/wrapper"
    local server_file="${service_dir}/server.js"

    bashio::log.info "Starting wrapper service on port ${wrapper_port}..."

    # Create upload directory if it doesn't exist
    mkdir -p "${upload_dir}"
    chmod 755 "${upload_dir}"

    # Export environment variables for the wrapper service
    export WRAPPER_PORT="${wrapper_port}"
    export TTYD_PORT="${ttyd_port}"
    export UPLOAD_DIR="${upload_dir}"

    # Check if server.js exists
    if [ ! -f "${server_file}" ]; then
        bashio::log.error "server.js not found at ${server_file}"
        ls -la "${service_dir}"
        return 1
    fi

    # Check if node_modules exists
    if [ ! -d "${service_dir}/node_modules" ]; then
        bashio::log.error "node_modules not found in ${service_dir}"
        bashio::log.info "Attempting to install dependencies..."
        if cd "${service_dir}" && npm install; then
            cd - > /dev/null
        else
            bashio::log.error "npm install failed"
            cd - > /dev/null 2>&1
        fi
    fi

    # Start under supervise so a crash is followed by a restart rather than a
    # permanent 502 on ingress. ttyd, exec'd later, keeps the container alive
    # either way, so without this nothing would ever notice the wrapper died.
    bashio::log.info "Starting Node.js service from ${server_file}..."
    supervise Wrapper run_wrapper "${server_file}" &
    bashio::log.info "Wrapper service supervisor started (PID: $!)"

    # Poll the health endpoint rather than checking a PID: the PID is the
    # supervisor, which is alive whether or not node is. Not fatal - supervise
    # keeps retrying, and failing startup here would only take ttyd down too.
    if wait_for_http "http://127.0.0.1:${wrapper_port}/health" 15; then
        bashio::log.info "Wrapper service is running successfully"
    else
        bashio::log.error "Wrapper service is not answering yet - check the [Wrapper] lines above"
    fi
}

# Run the wrapper once, prefixing its output into the add-on log. Under
# pipefail the pipeline's status is node's, which is what supervise reports.
run_wrapper() {
    node "$1" 2>&1 | while IFS= read -r line; do
        bashio::log.info "[Wrapper] $line"
    done
}

# supervise <name> <command...>
#
# Run a command forever, restarting it whenever it exits. Back-off doubles from
# 1s to a 30s cap so a crash loop does not flood the log, and resets after a run
# that stayed up for a minute - a crash after a long healthy run is not a loop.
#
# The command's failure is captured with `|| status=$?` rather than left to
# errexit: under bashio's `set -e` an unguarded failing command would end the
# loop on the first crash, which is the one thing it exists to survive.
#
# SUPERVISE_MAX_RUNS is a test seam, mirroring LEGACY_AUTH_PREFIX: unset in
# production, where the loop never returns.
supervise() {
    local name="$1"
    shift
    local delay=1 max_delay=30 healthy_after=60
    local runs=0 started status

    while true; do
        started=$SECONDS
        status=0
        "$@" || status=$?
        runs=$((runs + 1))

        if [ -n "${SUPERVISE_MAX_RUNS:-}" ] && [ "$runs" -ge "$SUPERVISE_MAX_RUNS" ]; then
            bashio::log.warning "${name} exited (status ${status})"
            return 0
        fi

        if [ $((SECONDS - started)) -ge "$healthy_after" ]; then
            delay=1
        fi
        bashio::log.warning "${name} exited (status ${status}); restarting in ${delay}s"
        sleep "$delay"
        delay=$((delay * 2))
        if [ "$delay" -gt "$max_delay" ]; then
            delay=$max_delay
        fi
    done
}

# wait_for_http <url> <attempts>
#
# Poll a URL once a second until it answers with a 2xx, or give up.
wait_for_http() {
    local url="$1" attempts="$2" i
    for ((i = 1; i <= attempts; i++)); do
        if curl -sf --max-time 2 "$url" > /dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# Create or attach to tmux session
# This function handles session lifecycle - creating new or reusing existing
setup_tmux_session() {
    local session_name="claude"
    local launch_command="$1"
    local workdir="$2"

    # Ensure TERM is set for proper color support in tmux
    export TERM="${TERM:-xterm-256color}"

    # Check if session already exists
    if tmux has-session -t "$session_name" 2>/dev/null; then
        bashio::log.info "tmux session '$session_name' exists - will attach"
    else
        bashio::log.info "Creating new tmux session '$session_name'..."
        # Create detached session running our command
        # The session runs bash with our launch command
        # Set TERM and COLORTERM explicitly for full color support
        tmux new-session -d -s "$session_name" -x 200 -y 50 -c "$workdir" \
            "TERM=xterm-256color COLORTERM=truecolor bash -l -c \"$launch_command; exec bash -l\""
        bashio::log.info "tmux session created successfully"
    fi
}

# Start main web terminal
start_web_terminal() {
    local port=7681
    local session_name="claude"
    bashio::log.info "Starting web terminal on port ${port}..."

    # Log environment information for debugging
    bashio::log.info "Environment variables:"
    bashio::log.info "ANTHROPIC_CONFIG_DIR=${ANTHROPIC_CONFIG_DIR}"
    bashio::log.info "HOME=${HOME}"

    # Get the appropriate launch command based on configuration
    local launch_command
    launch_command=$(get_claude_launch_command)

    # Log the configuration being used
    local auto_launch_claude
    auto_launch_claude=$(bashio::config 'auto_launch_claude' 'true')
    bashio::log.info "Auto-launch Claude: ${auto_launch_claude}"

    # The wrapper (UI, proxy, uploads) is already running: main() starts it
    # before the slow network-bound steps.

    # Create the tmux session BEFORE ttyd starts (key insight from ttyd#1396)
    # This avoids the "nested session" error because tmux session exists independently
    local workdir
    workdir=$(get_working_directory)
    bashio::log.info "Session working directory: ${workdir}"
    setup_tmux_session "$launch_command" "$workdir"

    # Run ttyd - it just attaches to the existing tmux session
    # Each browser connection gets attached to the same session
    #
    # Loopback only. The wrapper is the sole client (it proxies /terminal/ to
    # localhost), and it is where the WebSocket origin check lives. Bound to
    # 0.0.0.0, ttyd was a second, unguarded way into the same root session -
    # reachable by other containers on the hassio network even with 7681
    # unpublished.
    bashio::log.info "Starting ttyd with tmux attach..."
    exec ttyd \
        --port "${port}" \
        --interface 127.0.0.1 \
        --writable \
        tmux attach-session -t "$session_name"
}

# Run health check
run_health_check() {
    if [ -f "/opt/scripts/health-check.sh" ]; then
        bashio::log.info "Running system health check..."
        chmod +x /opt/scripts/health-check.sh
        /opt/scripts/health-check.sh || bashio::log.warning "Some health checks failed but continuing..."
    fi
}

# Setup ha-mcp (Home Assistant MCP Server) for Claude Code integration
setup_ha_mcp() {
    if [ -f "/opt/scripts/setup-ha-mcp.sh" ]; then
        bashio::log.info "Setting up Home Assistant MCP integration..."
        chmod +x /opt/scripts/setup-ha-mcp.sh
        # Source the script to get the configure function
        source /opt/scripts/setup-ha-mcp.sh
        configure_ha_mcp_server || bashio::log.warning "ha-mcp setup encountered issues but continuing..."
    else
        bashio::log.info "ha-mcp setup script not found, skipping MCP integration"
    fi
}

# Main execution
main() {
    bashio::log.info "Initializing Claude Terminal app..."

    init_environment
    export_oauth_token
    prune_uploaded_images

    # Serve the UI before anything that reaches the network. Package installs,
    # Docker CLI setup and ha-mcp registration can take minutes on a slow
    # link, and until the wrapper listens, ingress has nothing to talk to and
    # Home Assistant shows a bare 502. With it up, the page loads and its
    # terminal pane connects as soon as ttyd does.
    start_wrapper_service

    # Run diagnostics after environment is initialized (Claude binary needs PATH setup)
    run_health_check
    setup_session_picker
    setup_persistent_packages
    init_docker
    setup_ha_mcp

    # Last: ha-mcp must be registered, and persistent packages on PATH, before
    # the first Claude session launches inside tmux.
    start_web_terminal
}

# Execute main function, unless this file is being sourced.
#
# The guard matches the convention already used by health-check.sh and
# setup-ha-mcp.sh, and lets tests/ source this file to exercise individual
# helpers against stubbed bashio functions without starting the add-on.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
