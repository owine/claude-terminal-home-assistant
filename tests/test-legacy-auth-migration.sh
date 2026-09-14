#!/usr/bin/env bash
# Unit tests for migrate_legacy_auth_files in claude-terminal/run.sh.
#
# The migration exists to carry credentials from the locations older versions
# used into /data/.config/claude. It is documented as one-time, and for the two
# /root paths it is: they are replaced with a symlink, so a second run finds
# nothing to copy. The /config and /tmp sources have no such self-disabling
# step, so the copy repeated on every single boot and overwrote live
# credentials with whatever stale copy was still sitting in /config.
#
# LEGACY_AUTH_PREFIX is a test seam, empty in production, mirroring
# CLAUDE_BIN_PREFIX in health-check.sh: the legacy paths are absolute and
# cannot otherwise be relocated into a fixture tree.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="legacy auth migration"

# shellcheck source=claude-terminal/run.sh
. "$REPO_ROOT/claude-terminal/run.sh"
set +e

# Build a fixture tree: a prefix standing in for /, holding one legacy source
# directory with a credential in it, plus an empty migration target.
# Echoes "<prefix> <target>".
new_fixture() {
    local prefix target
    prefix=$(new_tmpdir)
    target="$prefix/data/.config/claude"
    mkdir -p "$target" "$prefix/config/claude-config"
    printf 'original-token\n' > "$prefix/config/claude-config/.credentials.json"
    printf '%s %s\n' "$prefix" "$target"
}

# ---------------------------------------------------------------------------
# The migration still migrates
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: first run"

read -r prefix target <<< "$(new_fixture)"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
assert_eq "a legacy credential is copied to the target" \
    "original-token" "$(cat "$target/.credentials.json" 2>/dev/null)"

# Credentials are 600 everywhere else in this add-on; a migrated one is no
# different just because it arrived by copy.
read -r prefix target <<< "$(new_fixture)"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
# shellcheck disable=SC2012  # a fixed fixture filename, and stat(1) flags differ between macOS and busybox
mode=$(ls -l "$target/.credentials.json" | cut -c2-10)
assert_eq "a migrated credential is not group- or world-readable" \
    "rw-------" "$mode"

# ---------------------------------------------------------------------------
# The migration does not repeat
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: second run"

# The bug. A user logs in again after the migration, so /data holds a fresh
# token while the stale one is still sitting in /config. The next restart must
# not put the stale one back.
read -r prefix target <<< "$(new_fixture)"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
printf 'freshly-logged-in\n' > "$target/.credentials.json"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
assert_eq "a second run does not overwrite a newer credential" \
    "freshly-logged-in" "$(cat "$target/.credentials.json" 2>/dev/null)"

# Same guarantee stated from the other side: the source is untouched and still
# present, so only the marker can be what stops the second copy.
read -r prefix target <<< "$(new_fixture)"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
assert_eq "the legacy source is left in place for the user to remove" \
    "original-token" "$(cat "$prefix/config/claude-config/.credentials.json" 2>/dev/null)"

# A source that was never migrated must still migrate later, so the marker has
# to record which path was done rather than that any migration ever ran.
read -r prefix target <<< "$(new_fixture)"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
mkdir -p "$prefix/tmp/claude-config"
printf 'later-source\n' > "$prefix/tmp/claude-config/.later.json"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
assert_eq "a legacy source that appears later is still migrated" \
    "later-source" "$(cat "$target/.later.json" 2>/dev/null)"

# ---------------------------------------------------------------------------
# Nothing to do
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: no legacy files"

prefix=$(new_tmpdir)
target="$prefix/data/.config/claude"
mkdir -p "$target"
out=$(LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>&1 >/dev/null)
assert_contains "an empty system reports nothing to migrate" \
    "$out" "No existing authentication files found"

# An empty legacy directory is not a migration, so it must not be marked as
# one - otherwise files dropped there afterwards would be ignored forever.
prefix=$(new_tmpdir)
target="$prefix/data/.config/claude"
mkdir -p "$target" "$prefix/config/claude-config"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
printf 'arrived-later\n' > "$prefix/config/claude-config/.credentials.json"
LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$target" 2>/dev/null
assert_eq "an empty legacy directory is not recorded as migrated" \
    "arrived-later" "$(cat "$target/.credentials.json" 2>/dev/null)"

# ---------------------------------------------------------------------------
# errexit
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: errexit"

# init_environment calls this under `set -e`. The marker lookup legitimately
# fails when the path has not been migrated yet, which must not be fatal.
read -r prefix target <<< "$(new_fixture)"
# shellcheck disable=SC2016  # $1/$2 are expanded by the inner shell
assert_status "survives errexit on a first and second run" 0 bash -c '
    set -e
    bashio::log.info() { :; }
    bashio::log.warning() { :; }
    bashio::log.debug() { :; }
    . "$1/claude-terminal/run.sh"
    export LEGACY_AUTH_PREFIX="$2"
    migrate_legacy_auth_files "$3"
    migrate_legacy_auth_files "$3"
' _ "$REPO_ROOT" "$prefix" "$target"

finish_suite
