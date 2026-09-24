#!/usr/bin/env bash
# Unit tests for migrate_legacy_auth_files and secure_claude_credentials in
# claude-terminal/run.sh.
#
# Claude Code keeps its login in two files under HOME (/data/home):
#   ~/.claude/.credentials.json   OAuth credentials
#   ~/.claude.json                account and settings
# It finds them through CLAUDE_CONFIG_DIR, falling back to ~/.claude, and
# never reads ANTHROPIC_CONFIG_DIR for them. The migration used to copy legacy
# credentials into /data/.config/claude (ANTHROPIC_CONFIG_DIR) - a directory
# Claude Code does not look in - so it restored nobody's login. It now maps
# the two files into HOME, and treats that old target as one more source.
#
# Two guarantees shape every case below:
#   - a live login is never overwritten: files are copied only where none
#     exists yet
#   - a migration happens once per source: after /logout deletes the
#     credential, the next boot must not bring a stale one back
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

# Build a fixture tree: a prefix standing in for /, an empty HOME, and one
# legacy source at /config/claude-config holding a credential - at the top
# level by default, or inside .claude/ with "nested", the layout that mirrors a
# real HOME. The never-clobber cases use "nested": it is the layout a blind
# copy into HOME would land on top of a live login with.
# Echoes "<prefix> <home>".
new_fixture() {
    local prefix home source
    prefix=$(new_tmpdir)
    home="$prefix/data/home"
    source="$prefix/config/claude-config"
    [ "${1:-}" = "nested" ] && source="$source/.claude"
    mkdir -p "$home" "$source"
    printf 'original-token\n' > "$source/.credentials.json"
    printf '%s %s\n' "$prefix" "$home"
}

migrate() { LEGACY_AUTH_PREFIX="$1" migrate_legacy_auth_files "$2" 2>/dev/null; }
cred() { cat "$1/.claude/.credentials.json" 2>/dev/null; }

# shellcheck disable=SC2012  # fixed fixture filenames; stat(1) flags differ between macOS and busybox
mode_of() { ls -l "$1" | cut -c2-10; }

# ---------------------------------------------------------------------------
# Where things land
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: destinations"

read -r prefix home <<< "$(new_fixture)"
migrate "$prefix" "$home"
assert_eq "a top-level legacy credential lands where Claude Code reads it" \
    "original-token" "$(cred "$home")"

# The original add-on mirrored /root into /config/claude-config, so the
# credential sat in a .claude/ directory there, as it does in a real HOME.
read -r prefix home <<< "$(new_fixture)"
rm "$prefix/config/claude-config/.credentials.json"
mkdir -p "$prefix/config/claude-config/.claude"
printf 'nested-token\n' > "$prefix/config/claude-config/.claude/.credentials.json"
migrate "$prefix" "$home"
assert_eq "a legacy credential inside .claude/ is found too" \
    "nested-token" "$(cred "$home")"

read -r prefix home <<< "$(new_fixture)"
printf '{"account":1}\n' > "$prefix/config/claude-config/.claude.json"
migrate "$prefix" "$home"
assert_eq "the legacy account file lands at ~/.claude.json" \
    '{"account":1}' "$(cat "$home/.claude.json" 2>/dev/null)"

read -r prefix home <<< "$(new_fixture)"
printf 'junk\n' > "$prefix/config/claude-config/unrelated.txt"
migrate "$prefix" "$home"
assert_status "nothing else from the source is copied into HOME" 1 test -e "$home/unrelated.txt"

# Users of every version since the target moved to /data/.config/claude had
# their credentials copied there, where Claude Code never looked.
prefix=$(new_tmpdir)
home="$prefix/data/home"
mkdir -p "$home" "$prefix/data/.config/claude"
printf 'stranded-token\n' > "$prefix/data/.config/claude/.credentials.json"
migrate "$prefix" "$home"
assert_eq "credentials stranded in the old target are recovered" \
    "stranded-token" "$(cred "$home")"

read -r prefix home <<< "$(new_fixture)"
printf '{}\n' > "$prefix/config/claude-config/.claude.json"
migrate "$prefix" "$home"
assert_eq "a migrated credential is not group- or world-readable" \
    "rw-------" "$(mode_of "$home/.claude/.credentials.json")"
assert_eq "nor is the migrated account file" \
    "rw-------" "$(mode_of "$home/.claude.json")"

# ---------------------------------------------------------------------------
# A live login always wins
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: never clobbers"

read -r prefix home <<< "$(new_fixture nested)"
mkdir -p "$home/.claude"
printf 'current-login\n' > "$home/.claude/.credentials.json"
migrate "$prefix" "$home"
assert_eq "an existing login is not overwritten on the first run" \
    "current-login" "$(cred "$home")"

read -r prefix home <<< "$(new_fixture nested)"
migrate "$prefix" "$home"
printf 'freshly-logged-in\n' > "$home/.claude/.credentials.json"
migrate "$prefix" "$home"
assert_eq "a second run does not overwrite a newer credential" \
    "freshly-logged-in" "$(cred "$home")"

# /logout deletes the credential. If the migration ran again, the next boot
# would silently log the user back in with the stale legacy one.
read -r prefix home <<< "$(new_fixture nested)"
migrate "$prefix" "$home"
rm "$home/.claude/.credentials.json"
migrate "$prefix" "$home"
assert_status "a logout is not undone by the next boot" 1 test -e "$home/.claude/.credentials.json"

# Same as above, for a source whose file was skipped because a login already
# existed: it has still been dealt with, and must not fill the gap a later
# /logout leaves.
read -r prefix home <<< "$(new_fixture nested)"
mkdir -p "$home/.claude"
printf 'current-login\n' > "$home/.claude/.credentials.json"
migrate "$prefix" "$home"
rm "$home/.claude/.credentials.json"
migrate "$prefix" "$home"
assert_status "a source skipped for an existing login is not replayed after logout" 1 \
    test -e "$home/.claude/.credentials.json"

read -r prefix home <<< "$(new_fixture)"
migrate "$prefix" "$home"
assert_eq "the legacy source is left in place for the user to remove" \
    "original-token" "$(cat "$prefix/config/claude-config/.credentials.json" 2>/dev/null)"

# The marker records which sources were handled, not that a migration ever
# ran, so a source that only appears later is still picked up.
read -r prefix home <<< "$(new_fixture)"
migrate "$prefix" "$home"
mkdir -p "$prefix/tmp/claude-config"
printf '{"later":1}\n' > "$prefix/tmp/claude-config/.claude.json"
migrate "$prefix" "$home"
assert_eq "a legacy source that appears later is still migrated" \
    '{"later":1}' "$(cat "$home/.claude.json" 2>/dev/null)"

# ---------------------------------------------------------------------------
# Nothing to do
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: no legacy files"

prefix=$(new_tmpdir)
home="$prefix/data/home"
mkdir -p "$home"
out=$(LEGACY_AUTH_PREFIX="$prefix" migrate_legacy_auth_files "$home" 2>&1 >/dev/null)
assert_contains "an empty system reports nothing to migrate" \
    "$out" "No existing authentication files found"

# A source with nothing Claude Code reads is not a migration, so it must not
# be marked as one - otherwise a credential dropped there later is ignored.
prefix=$(new_tmpdir)
home="$prefix/data/home"
mkdir -p "$home" "$prefix/config/claude-config"
printf 'junk\n' > "$prefix/config/claude-config/unrelated.txt"
migrate "$prefix" "$home"
printf 'arrived-later\n' > "$prefix/config/claude-config/.credentials.json"
migrate "$prefix" "$home"
assert_eq "a source holding no credential is not recorded as migrated" \
    "arrived-later" "$(cred "$home")"

# ---------------------------------------------------------------------------
# secure_claude_credentials
# ---------------------------------------------------------------------------
# The 600 pass used to run over /data/.config/claude only, so the files that
# actually hold the login were whatever mode Claude Code or a restore left.
printf '\n%s\n' "secure_claude_credentials"

home=$(new_tmpdir)
mkdir -p "$home/.claude"
printf 'x\n' > "$home/.claude/.credentials.json"
printf '{}\n' > "$home/.claude.json"
chmod 644 "$home/.claude/.credentials.json" "$home/.claude.json"
secure_claude_credentials "$home" 2>/dev/null
assert_eq "tightens the credential file to 600" \
    "rw-------" "$(mode_of "$home/.claude/.credentials.json")"
assert_eq "and the account file" \
    "rw-------" "$(mode_of "$home/.claude.json")"

home=$(new_tmpdir)
assert_status "succeeds when there is no login yet" 0 secure_claude_credentials "$home"

# ---------------------------------------------------------------------------
# Production shell semantics
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy_auth_files: bashio shell options"

# init_environment calls both under bashio's errexit, nounset and pipefail.
# The marker lookup and the "is there a login already?" tests legitimately
# fail, which must not be fatal.
read -r prefix home <<< "$(new_fixture)"
# shellcheck disable=SC2016  # expanded by the inner shell
assert_status "survives bashio's shell options on a first and second run" 0 run_under_bashio '
    . "$REPO_ROOT/claude-terminal/run.sh"
    export LEGACY_AUTH_PREFIX="$1"
    migrate_legacy_auth_files "$2"
    migrate_legacy_auth_files "$2"
    secure_claude_credentials "$2"
' "$prefix" "$home"

finish_suite
