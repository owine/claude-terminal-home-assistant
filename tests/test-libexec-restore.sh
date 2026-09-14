#!/usr/bin/env bash
# Unit tests for restore_persistent_libexec in claude-terminal/run.sh.
#
# /data/packages/bin and /data/packages/lib work because run.sh puts them on
# PATH and LD_LIBRARY_PATH. Nothing equivalent exists for libexec: the programs
# that use it look in a fixed absolute location (/usr/libexec/docker/cli-plugins
# for `docker compose`, /usr/libexec/git-core for git's helpers), and that
# location is on the container filesystem, which is rebuilt on every restart.
#
# So persisted libexec files have to be put back where they are looked for.
# PERSIST_LIBEXEC_DIR and LIBEXEC_TARGET_DIR are test seams with production
# defaults, same idea as CLAUDE_BIN_PREFIX in health-check.sh.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="libexec restore"

# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

# Echoes "<persisted libexec dir> <target libexec dir>".
new_fixture() {
    local root
    root=$(new_tmpdir)
    mkdir -p "$root/persisted/docker/cli-plugins" "$root/target"
    printf 'persisted-plugin\n' > "$root/persisted/docker/cli-plugins/docker-compose"
    chmod +x "$root/persisted/docker/cli-plugins/docker-compose"
    printf '%s %s\n' "$root/persisted" "$root/target"
}

restore() {
    PERSIST_LIBEXEC_DIR="$1" LIBEXEC_TARGET_DIR="$2" \
        restore_persistent_libexec 2>/dev/null
}

# ---------------------------------------------------------------------------
# Restoring
# ---------------------------------------------------------------------------
printf '\n%s\n' "restore_persistent_libexec"

read -r persisted target <<< "$(new_fixture)"
restore "$persisted" "$target"
assert_eq "a persisted helper reappears at its original relative path" \
    "persisted-plugin" "$(cat "$target/docker/cli-plugins/docker-compose" 2>/dev/null)"

# A plugin that is not executable is not a plugin - Docker skips it silently,
# which looks exactly like the plugin not being installed.
read -r persisted target <<< "$(new_fixture)"
restore "$persisted" "$target"
if [ -x "$target/docker/cli-plugins/docker-compose" ]; then
    _pass "the restored helper is still executable"
else
    _fail "the restored helper is still executable"
fi

# ---------------------------------------------------------------------------
# The image always wins
# ---------------------------------------------------------------------------
printf '\n%s\n' "restore_persistent_libexec: never overwrite the image's copy"

# The same hazard as the stale-credential migration, and as a stale .so on
# LD_LIBRARY_PATH: /data outlives the image, so a helper persisted against an
# older Alpine must never replace the one the current image shipped.
read -r persisted target <<< "$(new_fixture)"
mkdir -p "$target/docker/cli-plugins"
printf 'from-the-image\n' > "$target/docker/cli-plugins/docker-compose"
restore "$persisted" "$target"
assert_eq "an existing helper is left alone" \
    "from-the-image" "$(cat "$target/docker/cli-plugins/docker-compose" 2>/dev/null)"

# Restoring one file must not stop the others in the same directory.
read -r persisted target <<< "$(new_fixture)"
printf 'persisted-buildx\n' > "$persisted/docker/cli-plugins/docker-buildx"
mkdir -p "$target/docker/cli-plugins"
printf 'from-the-image\n' > "$target/docker/cli-plugins/docker-compose"
restore "$persisted" "$target"
assert_eq "a sibling helper is still restored alongside a skipped one" \
    "persisted-buildx" "$(cat "$target/docker/cli-plugins/docker-buildx" 2>/dev/null)"

# ---------------------------------------------------------------------------
# Nothing to do
# ---------------------------------------------------------------------------
printf '\n%s\n' "restore_persistent_libexec: nothing to restore"

root=$(new_tmpdir)
assert_status "a missing persisted directory succeeds" 0 \
    restore "$root/absent" "$root/target"

root=$(new_tmpdir)
mkdir -p "$root/persisted" "$root/target"
restore "$root/persisted" "$root/target"
assert_eq "an empty persisted directory leaves the target empty" \
    "" "$(ls -A "$root/target" 2>/dev/null)"

# Idempotent: the add-on restarts, and a restore that has already run must be a
# no-op rather than an error.
read -r persisted target <<< "$(new_fixture)"
restore "$persisted" "$target"
restore "$persisted" "$target"
assert_eq "restoring twice is a no-op" \
    "persisted-plugin" "$(cat "$target/docker/cli-plugins/docker-compose" 2>/dev/null)"

# ---------------------------------------------------------------------------
# errexit
# ---------------------------------------------------------------------------
printf '\n%s\n' "restore_persistent_libexec: errexit"

# init_environment runs under `set -e`, and the "does this already exist?" test
# legitimately fails for every file that needs restoring.
read -r persisted target <<< "$(new_fixture)"
# shellcheck disable=SC2016  # $1..$3 are expanded by the inner shell
assert_status "survives errexit" 0 bash -c '
    set -e
    bashio::log.info() { :; }
    . "$1/claude-terminal/run.sh"
    export PERSIST_LIBEXEC_DIR="$2" LIBEXEC_TARGET_DIR="$3"
    restore_persistent_libexec
' _ "$REPO_ROOT" "$persisted" "$target"

finish_suite
