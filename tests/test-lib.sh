#!/usr/bin/env bash
# Tests for the test harness itself (tests/lib.sh).

# shellcheck source=tests/lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"

CURRENT_SUITE="lib.sh"

printf '\n%s\n' "new_tmpdir cleanup"

# Every suite calls new_tmpdir as `dir=$(new_tmpdir)`, and command substitution
# runs it in a subshell - so anything it records in a shell variable is lost
# before the EXIT trap looks. Each full run leaked a couple of dozen
# directories into $TMPDIR.
dir=$(new_tmpdir)
assert_status "the directory exists while the suite runs" 0 test -d "$dir"
cleanup_tmpdirs
assert_status "a directory made in a subshell is removed by the cleanup" 1 test -e "$dir"

finish_suite
