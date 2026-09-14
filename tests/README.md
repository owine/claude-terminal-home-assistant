# Shell test suite

Unit tests for the add-on's startup scripts — `claude-terminal/run.sh` and
`claude-terminal/scripts/health-check.sh`.

```bash
tests/run-tests.sh            # every suite
tests/run-tests.sh health     # only suites whose filename matches "health"
```

No dependencies beyond bash and the usual POSIX tools. Runs in CI as the
**Unit tests** job in `test.yml`, alongside the wrapper's JavaScript tests.

## How it works

The scripts under test are container startup code: they run under
`#!/usr/bin/with-contenv bashio`, read add-on options from the Supervisor API,
and write to `/data`. None of that exists on a developer laptop or a CI runner.

So each suite sources the script under test with `bashio` stubbed, and points
it at a temporary fixture tree:

- **`main` is not executed.** `run.sh`, `health-check.sh`, `setup-ha-mcp.sh`
  and `persist-install` all guard their entrypoint with
  `[ "${BASH_SOURCE[0]}" = "${0}" ]`, so sourcing them defines functions
  without starting the add-on.
- **Absolute paths reach fixtures through a prefix seam.** `CLAUDE_BIN_PREFIX`
  (health-check.sh) and `LEGACY_AUTH_PREFIX` (run.sh) are empty in production
  and set by a test to a temporary directory standing in for `/`. Paths like
  `/root/.config/anthropic` cannot be relocated any other way.
- **`bashio::config`** reads from values recorded by `set_config`, so a test
  can simulate any add-on option without a Supervisor.
- **`bashio::log.*` writes to stderr**, because that is what the real bashio
  does (it writes to `$LOG_FD`, never stdout). This is load-bearing, not
  cosmetic: helpers like `get_working_directory` return their result on stdout
  via command substitution, so a log line leaking onto stdout would be spliced
  into the returned path. Stubbing the log functions to stdout would hide that
  class of bug.

## Adding a suite

Create `tests/test-<thing>.sh`; the runner picks it up automatically.

```bash
. "$(dirname -- "${BASH_SOURCE[0]}")/lib.sh"
CURRENT_SUITE="my thing"
. "$REPO_ROOT/claude-terminal/run.sh"
set +e   # run.sh sets errexit at the top level; the driver does not want it

reset_config
set_config some_option "value"
assert_eq "description" "expected" "$(some_function)"

finish_suite
```

Available assertions: `assert_eq`, `assert_contains`, `assert_not_contains`,
`assert_status`. Fixtures: `new_tmpdir` (auto-removed on exit) and `make_stub`
(writes an executable stub with a chosen exit status, stdout and stderr).

## Writing tests that are worth having

Each case here corresponds to a bug that actually shipped or was caught in
review — a broken binary reported as healthy, a credential written into
backups, a token logged in plaintext, a fallback path corrupted by its own
warning. When adding a test, prefer reproducing a concrete failure over
covering a line.

Verify a new test can fail. Reintroduce the bug, watch the suite go red, then
revert. A test that has never failed has not been tested.

## Portability

Suites must run on **bash 3.2** as well as bash 5: macOS still ships 3.2 as
`/bin/bash`, and the container has 5.3. In particular, `declare -A` is
unavailable on 3.2 — and fails quietly in a way that corrupts lookups rather
than erroring, so `lib.sh` stores config values in individual variables
instead.

They must also run on a **stock macOS** with no Homebrew on `PATH`. The one
tool that is genuinely missing there is `timeout`, which `check_claude_cli`
uses to guard its runnability probe; Alpine has it via busybox, macOS has none.
`lib.sh` defines a shim only when no real `timeout` is found, so the suite is
runnable either way and the container still uses the real thing. (`readlink -f`
needs no shim — current macOS supports it, despite the BSD `readlink` of
folklore.)

Worth re-checking with:

```bash
env PATH="/usr/bin:/bin:/usr/sbin:/sbin" tests/run-tests.sh
```

## Test seams in production code

`check_claude_cli` probes absolute install paths that cannot be relocated, so
it honours `CLAUDE_BIN_PREFIX` — empty in production, set by tests to point at
a fixture tree. It is the only such seam; prefer designing functions to take
their inputs as arguments or environment over adding more.
