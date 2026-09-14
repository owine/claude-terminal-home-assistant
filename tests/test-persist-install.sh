#!/usr/bin/env bash
# Unit tests for the file-classification helper in claude-terminal/scripts/persist-install.
#
# persist-install guards its `main` call with a BASH_SOURCE check, so sourcing
# it here defines the functions without installing anything.
#
# The behaviour under test is the one that made the whole feature a no-op:
# `apk info -L` reports paths RELATIVE to /, preceded by a header line, and the
# original classifier matched absolute paths only - so nothing was ever copied
# to /data and every install reported success while persisting nothing.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="persist-install"

# shellcheck source=claude-terminal/scripts/persist-install
. "$REPO_ROOT/claude-terminal/scripts/persist-install"

# Point the destinations at fixtures so the assertions do not depend on /data.
PERSIST_ROOT=$(new_tmpdir)
PERSIST_BIN="$PERSIST_ROOT/bin"
PERSIST_LIB="$PERSIST_ROOT/lib"
PERSIST_LIBEXEC="$PERSIST_ROOT/libexec"

# ---------------------------------------------------------------------------
# persist_target_dir - the real `apk info -L` output shape
# ---------------------------------------------------------------------------
printf '\n%s\n' "persist_target_dir: relative paths (what apk actually emits)"

# Verified against Alpine 3.21:
#   $ apk info -L tree
#   tree-2.2.1-r0 contains:
#   usr/bin/tree
assert_eq "usr/bin/* is a binary" \
    "$PERSIST_BIN" "$(persist_target_dir 'usr/bin/tree')"

assert_eq "usr/sbin/* is a binary" \
    "$PERSIST_BIN" "$(persist_target_dir 'usr/sbin/nologin')"

assert_eq "bin/* is a binary" \
    "$PERSIST_BIN" "$(persist_target_dir 'bin/busybox')"

assert_eq "sbin/* is a binary" \
    "$PERSIST_BIN" "$(persist_target_dir 'sbin/apk')"

assert_eq "a versioned shared library is a library" \
    "$PERSIST_LIB" "$(persist_target_dir 'usr/lib/libfoo.so.1.2.3')"

assert_eq "an unversioned shared library is a library" \
    "$PERSIST_LIB" "$(persist_target_dir 'usr/lib/libfoo.so')"

assert_eq "a shared library below /lib is a library" \
    "$PERSIST_LIB" "$(persist_target_dir 'lib/libz.so.1')"

# ---------------------------------------------------------------------------
# persist_target_dir - libexec helpers
# ---------------------------------------------------------------------------
printf '\n%s\n' "persist_target_dir: libexec keeps its directory structure"

# Unlike bin and lib, which flatten, libexec MUST keep its relative path: the
# programs that look there find helpers by exact location, not by PATH. The
# Docker CLI searches /usr/libexec/docker/cli-plugins for `docker compose`, so a
# docker-compose flattened into bin/ would leave `docker compose` unavailable
# while a stray `docker-compose` appeared on PATH.
assert_eq "a CLI plugin keeps its plugin directory" \
    "$PERSIST_LIBEXEC/docker/cli-plugins" \
    "$(persist_target_dir 'usr/libexec/docker/cli-plugins/docker-compose')"

assert_eq "a git helper keeps its git-core directory" \
    "$PERSIST_LIBEXEC/git-core" \
    "$(persist_target_dir 'usr/libexec/git-core/git-submodule')"

assert_eq "a helper directly under libexec has no subdirectory" \
    "$PERSIST_LIBEXEC" "$(persist_target_dir 'usr/libexec/helper')"

assert_eq "an absolute libexec path classifies the same way" \
    "$PERSIST_LIBEXEC/docker/cli-plugins" \
    "$(persist_target_dir '/usr/libexec/docker/cli-plugins/docker-buildx')"

# ---------------------------------------------------------------------------
# persist_target_dir - lines that must be ignored
# ---------------------------------------------------------------------------
printf '\n%s\n' "persist_target_dir: lines that are not persistable files"

# The first line of `apk info -L` output names the package. Treating it as a
# path would try to copy a file called "tree-2.2.1-r0 contains:".
assert_eq "the apk header line is ignored" \
    "" "$(persist_target_dir 'tree-2.2.1-r0 contains:')"

assert_eq "an empty line is ignored" \
    "" "$(persist_target_dir '')"

assert_eq "documentation is not persisted" \
    "" "$(persist_target_dir 'usr/share/doc/tree/README')"

assert_eq "configuration is not persisted" \
    "" "$(persist_target_dir 'etc/foo.conf')"

# A static archive is not loadable at runtime, and LD_LIBRARY_PATH cannot use
# it. Only the .so pattern belongs in the persistent lib directory.
assert_eq "a static archive is not persisted" \
    "" "$(persist_target_dir 'usr/lib/libfoo.a')"

# ---------------------------------------------------------------------------
# persist_target_dir - absolute input
# ---------------------------------------------------------------------------
printf '\n%s\n' "persist_target_dir: absolute paths still classify"

# Nothing in the add-on feeds absolute paths in today, but accepting both
# spellings means a future caller cannot silently reintroduce the original bug.
assert_eq "an absolute binary path classifies" \
    "$PERSIST_BIN" "$(persist_target_dir '/usr/bin/tree')"

assert_eq "an absolute library path classifies" \
    "$PERSIST_LIB" "$(persist_target_dir '/usr/lib/libfoo.so.1')"

# ---------------------------------------------------------------------------
# persist_absolute_path - normalising a listed line to a real path
# ---------------------------------------------------------------------------
printf '\n%s\n' "persist_absolute_path"

# The classifier says WHERE a file goes; this says WHICH file to read. Copying
# the raw relative path would resolve against the caller's cwd instead of /.
assert_eq "a relative path is anchored at /" \
    "/usr/bin/tree" "$(persist_absolute_path 'usr/bin/tree')"

assert_eq "an absolute path is left alone" \
    "/usr/bin/tree" "$(persist_absolute_path '/usr/bin/tree')"

finish_suite
