#!/usr/bin/env bash
# Unit tests for claude-terminal/scripts/persist-install: the file-classification
# helper, and the exit status and persistence of the install paths.
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
PERSIST_PYTHON="$PERSIST_ROOT/python"

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

# ---------------------------------------------------------------------------
# Install paths - exit status and what actually lands in /data
# ---------------------------------------------------------------------------
#
# run.sh calls `persist-install ... || bashio::log.warning ...`, so the exit
# status is the only way a failure reaches the add-on log. The install
# functions `exit` on failure, so each case runs them in a subshell with apk,
# pip and python3 stubbed on PATH.

# A file that exists on both macOS and Alpine, so a stubbed `apk info -L` can
# list it and the copy step has something real to persist.
FIXTURE_LISTED_FILE="bin/sh"

# Stub apk. `apk add` records its arguments and succeeds. `apk info -L` mimics
# the real thing, verified against the add-on image (Alpine 3.24):
#   $ apk info -L curl        -> "curl-8.22.0-r0 contains:" + relative paths
#   $ apk info -L 'curl=0'    -> no output at all, status 1
#   $ apk info -L 'curl>1'    -> no output at all, status 1 (same for <, ~, @tag)
# i.e. a spec carrying a version constraint lists NOTHING. The package named
# "ghost" also lists nothing, to reach the empty-listing guard with a bare name.
make_apk_stub() {
    local dir="$1"
    mkdir -p "$dir"
    cat > "$dir/apk" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$dir/apk.log"
case "\$1" in
    add) exit 0 ;;
    info)
        name="\$3"
        case "\$name" in
            *[=\<\>~@]*|ghost) exit 1 ;;
        esac
        printf '%s-1.0-r0 contains:\n' "\$name"
        printf '%s\n' "$FIXTURE_LISTED_FILE"
        exit 0
        ;;
esac
exit 0
EOF
    chmod +x "$dir/apk"
}

# Stub python3. `-c` answers the version probe; `-m venv DIR` builds a minimal
# venv (pyvenv.cfg + an empty activate script) and exits with <venv status>.
#   make_python_stub <dir> <venv status>
make_python_stub() {
    local dir="$1" venv_status="$2"
    mkdir -p "$dir"
    cat > "$dir/python3" <<EOF
#!/bin/sh
case "\$1" in
    -c) echo 3.14 ;;
    -m)
        [ "$venv_status" -eq 0 ] || exit "$venv_status"
        mkdir -p "\$3/bin"
        printf 'version = 3.14.0\n' > "\$3/pyvenv.cfg"
        : > "\$3/bin/activate"
        ;;
esac
exit 0
EOF
    chmod +x "$dir/python3"
}

# A venv already present and matching the stubbed interpreter, so the install
# goes straight to pip without rebuilding it.
make_existing_venv() {
    mkdir -p "$PERSIST_PYTHON/venv/bin"
    printf 'version = 3.14.0\n' > "$PERSIST_PYTHON/venv/pyvenv.cfg"
    : > "$PERSIST_PYTHON/venv/bin/activate"
}

reset_install_fixtures() {
    rm -rf "$PERSIST_ROOT" && mkdir -p "$PERSIST_ROOT"
}

# persisted_fixture - "yes" when the listed fixture file reached PERSIST_BIN.
#
# -L as well as -f: the copy is `cp -a`, which keeps a symlink a symlink, and
# /bin/sh is one on most hosts. On Alpine it points at /bin/busybox (absolute,
# so -f follows it fine); on Ubuntu it is a RELATIVE link to dash, which
# dangles once copied into PERSIST_BIN, so -f alone reported a persisted file
# as missing and failed only on the CI runner.
persisted_fixture() {
    local copied
    copied="$PERSIST_BIN/$(basename "$FIXTURE_LISTED_FILE")"
    if [ -L "$copied" ] || [ -f "$copied" ]; then
        echo yes
    else
        echo no
    fi
}

# run_install <stub dir> <function> [args...] - run an install function in a
# subshell (it may `exit`) with the stubs first on PATH. Sets INSTALL_OUTPUT
# and INSTALL_STATUS.
run_install() {
    local stubs="$1"
    shift
    INSTALL_STATUS=0
    INSTALL_OUTPUT=$( (PATH="$stubs:$PATH"; "$@") 2>&1 ) || INSTALL_STATUS=$?
}

printf '\n%s\n' "install_python_packages: exit status reflects the install"

# pip failing used to be followed by an unconditional echo, so the script
# exited 0 and printed success: run.sh's `|| bashio::log.warning` could never
# fire, and the user was told a failed install had worked.
reset_install_fixtures
stubs=$(new_tmpdir)
make_python_stub "$stubs" 0
make_stub "$stubs/pip" 1 "" "ERROR: No matching distribution found for nosuchpkg"
make_existing_venv
run_install "$stubs" install_python_packages nosuchpkg
assert_eq "a failed pip install exits non-zero" "1" "$INSTALL_STATUS"
assert_not_contains "a failed pip install does not report success" \
    "$INSTALL_OUTPUT" "Python packages installed!"

# `python3 -m venv` was unchecked too: a venv that could not be created was
# announced as ready, and everything after it ran against nothing.
reset_install_fixtures
stubs=$(new_tmpdir)
make_python_stub "$stubs" 1
make_stub "$stubs/pip" 0
run_install "$stubs" install_python_packages requests
assert_eq "a failed venv creation exits non-zero" "1" "$INSTALL_STATUS"
assert_not_contains "a failed venv creation is not announced as ready" \
    "$INSTALL_OUTPUT" "Virtual environment ready"

# The happy path must still succeed - both when the venv is built on the spot
# and when it already exists.
reset_install_fixtures
stubs=$(new_tmpdir)
make_python_stub "$stubs" 0
make_stub "$stubs/pip" 0
run_install "$stubs" install_python_packages requests
assert_eq "a successful install into a new venv exits 0" "0" "$INSTALL_STATUS"
assert_contains "a successful install reports success" \
    "$INSTALL_OUTPUT" "Python packages installed!"

reset_install_fixtures
make_existing_venv
run_install "$stubs" install_python_packages requests
assert_eq "a successful install into an existing venv exits 0" "0" "$INSTALL_STATUS"

printf '\n%s\n' "install_system_packages: versioned specs still persist"

# `apk add 'pkg=1.2-r0'` installs fine, but `apk info -L 'pkg=1.2-r0'` lists
# nothing, so the package was installed for this boot only while the script
# reported it persisted. The lookup must use the bare package name.
for spec in 'fixture=1.0-r0' 'fixture>1.0' 'fixture<2' 'fixture~1.0' 'fixture@edge'; do
    reset_install_fixtures
    stubs=$(new_tmpdir)
    make_apk_stub "$stubs"
    run_install "$stubs" install_system_packages "$spec"
    assert_eq "$spec: exits 0" "0" "$INSTALL_STATUS"
    assert_eq "$spec: its files are persisted" "yes" "$(persisted_fixture)"
done

# A bare name must keep working exactly as before.
reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
run_install "$stubs" install_system_packages fixture
assert_eq "a bare name exits 0" "0" "$INSTALL_STATUS"
assert_eq "a bare name's files are persisted" "yes" "$(persisted_fixture)"

printf '\n%s\n' "install_system_packages: an empty file list is a failure"

# Independent of how the name is derived: if apk lists nothing for a package,
# nothing was persisted, and saying otherwise hides the failure until reboot.
reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
run_install "$stubs" install_system_packages fixture ghost
assert_eq "a package with no file list exits non-zero" "1" "$INSTALL_STATUS"
assert_not_contains "a package with no file list is not reported persisted" \
    "$INSTALL_OUTPUT" "installed and persisted!"
assert_contains "the failure names the package" \
    "$INSTALL_OUTPUT" "apk lists no files for ghost"
assert_eq "the other package in the same call is still persisted" \
    "yes" "$(persisted_fixture)"

printf '\n%s\n' "install_system_packages: names starting with - are rejected"

# A leading dash is an option, not a package. Passed through, apk would act on
# it (--allow-untrusted, -X <repo>). Reject it before anything is installed.
for bad in '--allow-untrusted' '-X' '--foo'; do
    reset_install_fixtures
    stubs=$(new_tmpdir)
    make_apk_stub "$stubs"
    run_install "$stubs" install_system_packages vim "$bad"
    assert_eq "$bad: exits non-zero" "1" "$INSTALL_STATUS"
    assert_contains "$bad: the error names it" \
        "$INSTALL_OUTPUT" "Invalid package name: $bad"
    assert_eq "$bad: apk is never called" \
        "no" "$([ -e "$stubs/apk.log" ] && echo yes || echo no)"
done

finish_suite
