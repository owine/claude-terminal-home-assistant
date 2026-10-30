#!/usr/bin/env bash
# Unit tests for claude-terminal/scripts/persist-install: the recorded package
# list (world), apk's persistent cache, the replay run.sh does on every start,
# the one-time migration of copies the earlier version left behind, and the
# exit status of the install paths.
#
# persist-install guards its `main` call with a BASH_SOURCE check, so sourcing
# it here defines the functions without installing anything.

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="persist-install"

# shellcheck source=claude-terminal/scripts/persist-install
. "$REPO_ROOT/claude-terminal/scripts/persist-install"

# Point everything at fixtures so the assertions do not depend on /data.
PERSIST_ROOT=$(new_tmpdir)
set_persist_paths() {
    PERSIST_WORLD="$PERSIST_ROOT/world"
    PERSIST_CACHE="$PERSIST_ROOT/apk-cache"
    PERSIST_PYTHON="$PERSIST_ROOT/python"
    PERSIST_LEGACY_BIN="$PERSIST_ROOT/bin"
    PERSIST_MIGRATED="$PERSIST_ROOT/.legacy-migrated"
}
set_persist_paths

# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------
#
# run.sh calls `persist-install ... || bashio::log.warning ...`, so the exit
# status is the only way a failure reaches the app log. The install functions
# `exit` on failure, so each case runs them in a subshell with apk, pip and
# python3 stubbed on PATH.

# Stub apk, modelled on apk-tools 3.0.8 in the add-on image (checked there):
# - `add` is all or nothing: one unknown package fails the whole call
# - `add --no-network` installs only what the cache holds
# - `info -e <name>` exits 0 when <name> is installed
# - `search -q -x cmd:<command>` prints the name of each package providing it
# State lives beside the stub: installed, bad (never installable), cached
# (installable offline), provides ("<command> <package>" lines), and the
# marker files offline (every online add fails) and no-index (search fails).
make_apk_stub() {
    local dir="$1"
    mkdir -p "$dir"
    : > "$dir/installed"; : > "$dir/bad"; : > "$dir/cached"; : > "$dir/provides"
    cat > "$dir/apk" <<EOF
#!/bin/bash
state="$dir"
printf '%s\n' "\$*" >> "\$state/apk.log"
name_of() { printf '%s\n' "\${1%%[=<>~@]*}"; }
case "\$1" in
    add)
        shift
        offline=no specs=()
        while [ \$# -gt 0 ]; do
            case "\$1" in
                --cache-dir) shift ;;
                --no-network) offline=yes ;;
                -*) ;;
                *) specs+=("\$1") ;;
            esac
            shift
        done
        [ "\$offline" = no ] && [ -e "\$state/offline" ] && exit 1
        for spec in "\${specs[@]}"; do
            name=\$(name_of "\$spec")
            grep -qx "\$name" "\$state/bad" && exit 1
            [ "\$offline" = yes ] && ! grep -qx "\$name" "\$state/cached" && exit 1
        done
        for spec in "\${specs[@]}"; do name_of "\$spec" >> "\$state/installed"; done
        exit 0
        ;;
    info)
        grep -qx "\$3" "\$state/installed"
        exit \$?
        ;;
    search)
        [ -e "\$state/no-index" ] && exit 1
        cmd="\${4#cmd:}"
        [ "\$cmd" = sh ] && { echo busybox-binsh; exit 0; }
        awk -v c="\$cmd" '\$1 == c { print \$2 }' "\$state/provides"
        exit 0
        ;;
esac
exit 0
EOF
    chmod +x "$dir/apk"
}

world() { tr '\n' ' ' < "$PERSIST_WORLD" 2>/dev/null | sed 's/ $//'; }
apk_calls() { grep -c . "$1/apk.log" 2>/dev/null || echo 0; }

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

# ---------------------------------------------------------------------------
# install_system_packages - install and record
# ---------------------------------------------------------------------------
printf '\n%s\n' "install_system_packages: installs through the cache and records"

reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
run_install "$stubs" install_system_packages htop tree
assert_eq "exits 0" "0" "$INSTALL_STATUS"
assert_eq "both are recorded, sorted" "htop tree" "$(world)"
assert_contains "apk keeps its downloads in the persistent cache" \
    "$(cat "$stubs/apk.log")" "--cache-dir $PERSIST_CACHE"
assert_contains "and says they persist" "$INSTALL_OUTPUT" "installed and persisted!"

# A constrained spec is recorded as typed - that is what gets replayed - and
# replaces the bare entry for the same package instead of sitting beside it.
run_install "$stubs" install_system_packages 'htop=3.5.3-r0'
assert_eq "a spec replaces the entry for its package" "htop=3.5.3-r0 tree" "$(world)"
for spec in 'tree>2' 'tree<9' 'tree~2.3' 'tree@edge'; do
    run_install "$stubs" install_system_packages "$spec"
    assert_eq "$spec: exits 0 and is recorded as typed" "0 htop=3.5.3-r0 $spec" "$INSTALL_STATUS $(world)"
done

printf '\n%s\n' "install_system_packages: only what installed is recorded"

# One unknown package fails apk's single transaction; the others must still
# install and be recorded, the unknown one must not be replayed every start.
reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
echo ghost > "$stubs/bad"
run_install "$stubs" install_system_packages htop ghost
assert_eq "a package that cannot install exits non-zero" "1" "$INSTALL_STATUS"
assert_eq "the others are installed and recorded; it is not" "htop" "$(world)"
assert_not_contains "and the run is not reported a success" "$INSTALL_OUTPUT" "installed and persisted!"

printf '\n%s\n' "install_system_packages: names starting with - are rejected"

# A leading dash is an option, not a package. Passed through, apk would act on
# it (--allow-untrusted, -X <repo>). Reject it before anything is installed.
for bad in '--allow-untrusted' '-X' '--foo'; do
    reset_install_fixtures
    stubs=$(new_tmpdir)
    make_apk_stub "$stubs"
    run_install "$stubs" install_system_packages vim "$bad"
    assert_eq "$bad: exits non-zero" "1" "$INSTALL_STATUS"
    assert_contains "$bad: the error names it" "$INSTALL_OUTPUT" "Invalid package name: $bad"
    assert_eq "$bad: apk is never called" "0" "$(apk_calls "$stubs")"
    assert_eq "$bad: nothing is recorded" "" "$(world)"
done

# ---------------------------------------------------------------------------
# --no-record and --remove
# ---------------------------------------------------------------------------
printf '\n%s\n' "install_unrecorded and remove_packages"

# Packages an app option owns (persistent_apk_packages, enable_docker) go
# through the cache but not into the list: the option is their record.
reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
run_install "$stubs" install_unrecorded docker-cli docker-cli-compose
assert_eq "--no-record installs" "0" "$INSTALL_STATUS"
assert_eq "and records nothing" "" "$(world)"
assert_contains "through the persistent cache" "$(cat "$stubs/apk.log")" "--cache-dir $PERSIST_CACHE"
run_install "$stubs" install_unrecorded -X
assert_eq "--no-record rejects option names too" "1" "$INSTALL_STATUS"

reset_install_fixtures
printf 'htop\ncurl=8.1-r0\ntree\n' > "$PERSIST_WORLD"
run_install "$stubs" remove_packages curl htop
assert_eq "--remove drops entries by package name, constrained or not" "tree" "$(world)"

# ---------------------------------------------------------------------------
# restore_packages - what run.sh replays on every start
# ---------------------------------------------------------------------------
printf '\n%s\n' "restore_packages"

reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
run_install "$stubs" restore_packages
assert_eq "an empty list restores nothing and succeeds" "0 0" "$INSTALL_STATUS $(apk_calls "$stubs")"

printf 'htop\ntree>2\n' > "$PERSIST_WORLD"
run_install "$stubs" restore_packages
assert_eq "the list is replayed in one apk call" "0 1" "$INSTALL_STATUS $(apk_calls "$stubs")"
assert_eq "both are installed" "htop tree" "$(tr '\n' ' ' < "$stubs/installed" | sed 's/ $//')"

# No network: whatever the cache holds still comes back, and the rest is a
# failure for the log rather than a silent gap.
reset_install_fixtures
stubs=$(new_tmpdir)
make_apk_stub "$stubs"
: > "$stubs/offline"
echo htop > "$stubs/cached"
printf 'htop\ntree\n' > "$PERSIST_WORLD"
run_install "$stubs" restore_packages
assert_eq "offline, a cached package is restored" "htop" "$(cat "$stubs/installed")"
assert_eq "and the uncached one makes the restore fail" "1" "$INSTALL_STATUS"
assert_contains "naming it" "$INSTALL_OUTPUT" "✗ tree"
assert_eq "the list itself is untouched" "htop tree" "$(world)"

# ---------------------------------------------------------------------------
# migrate_legacy - copies the earlier version left in $PERSIST_ROOT/bin
# ---------------------------------------------------------------------------
printf '\n%s\n' "migrate_legacy"

system_bin=$(new_tmpdir)
SYSTEM_BIN_DIRS="$system_bin"
legacy_fixture() {
    reset_install_fixtures
    stubs=$(new_tmpdir)
    make_apk_stub "$stubs"
    mkdir -p "$PERSIST_LEGACY_BIN"
    local name
    for name in "$@"; do : > "$PERSIST_LEGACY_BIN/$name"; done
}

# htop: one provider. docker: two (docker-cli, podman-docker). jq: already on
# the system (image, restore or an option put it there). mystery: no provider.
legacy_fixture htop docker jq mystery
: > "$system_bin/jq"
printf 'htop htop\ndocker docker-cli\ndocker podman-docker\n' > "$stubs/provides"
run_install "$stubs" migrate_legacy
assert_eq "migration never fails startup" "0" "$INSTALL_STATUS"
assert_eq "a command with one provider becomes a recorded package" "htop" "$(world)"
assert_eq "and is installed" "htop" "$(cat "$stubs/installed")"
assert_contains "ambiguous and unknown commands are reported, not guessed" \
    "$INSTALL_OUTPUT" "No single package provides: docker mystery"
assert_not_contains "a command already on the system is left alone" "$INSTALL_OUTPUT" "jq"
assert_eq "it is marked done" "yes" "$([ -e "$PERSIST_MIGRATED" ] && echo yes || echo no)"
calls=$(apk_calls "$stubs")
run_install "$stubs" migrate_legacy
assert_eq "and does not run again" "$calls" "$(apk_calls "$stubs")"

# No package index (no network at boot): decide nothing, try next start.
legacy_fixture htop
: > "$stubs/no-index"
run_install "$stubs" migrate_legacy
assert_eq "without an index nothing is recorded" "" "$(world)"
assert_eq "and it is not marked done" "no" "$([ -e "$PERSIST_MIGRATED" ] && echo yes || echo no)"

# An install that fails is retried next start too.
legacy_fixture htop
echo "htop htop" > "$stubs/provides"
echo htop > "$stubs/bad"
run_install "$stubs" migrate_legacy
assert_eq "a failed migration install exits 0 for startup" "0" "$INSTALL_STATUS"
assert_eq "and is not marked done" "no" "$([ -e "$PERSIST_MIGRATED" ] && echo yes || echo no)"

# Nothing to migrate: marked done without asking apk anything.
legacy_fixture
run_install "$stubs" migrate_legacy
assert_eq "no legacy copies: done, no apk call" "yes 0" \
    "$([ -e "$PERSIST_MIGRATED" ] && echo yes || echo no) $(apk_calls "$stubs")"

finish_suite
