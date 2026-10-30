# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Terminal Prowine** — a Home Assistant app providing a web-based terminal with Claude Code CLI pre-installed and persistent package management.

**Fork Attribution:** Personal fork by [@owine](https://github.com/owine), built upon:
- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) - Original by Tom Cassady
- [ESJavadex/claude-code-ha](https://github.com/ESJavadex/claude-code-ha) - Enhanced fork by Javier Santos

## Development Environment

### Prerequisites
Install the toolchain locally (macOS via Homebrew):
```bash
brew install hadolint shellcheck yamllint actionlint ruff node
# Plus Docker (container runtime) and curl/jq
```

### Build & Test
```bash
# Build the image. base:3.24 is multi-arch, so buildx picks the arch; pass
# --platform linux/arm64 to cross-build. The tag (no digest) is fine for local
# dev — the committed Dockerfile pins base:3.24 by digest (Renovate-managed).
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/base:3.24 \
  -t local/claude-terminal-prowine ./claude-terminal
# Add --no-cache when npm or Python dependencies change

# Run locally (7680 = web UI/ingress; ttyd is loopback-only inside the container), then test the web UI.
# run.sh reads every option from the Supervisor API; outside HA there is none and
# bashio aborts startup, so start the stub first (tests/stub-supervisor.py header)
python3 tests/stub-supervisor.py &
docker run -p 7680:7680 -v "$(pwd)/config:/config" \
  -e SUPERVISOR_API=http://host.docker.internal:8099 \
  --add-host=host.docker.internal:host-gateway local/claude-terminal-prowine
curl -X GET http://localhost:7680/

# Shell unit tests for the startup scripts (run.sh, health-check.sh). No deps,
# no container: each suite sources the script with bashio stubbed and points it
# at a fixture tree. Runs in CI as the "Unit tests" job. See tests/README.md.
tests/run-tests.sh
tests/run-tests.sh health     # filter by filename

# Wrapper JS unit tests
(cd claude-terminal/wrapper && npm test)

# Integration test: real browsers against a real tmux. NOT part of `npm test`,
# but CI does run it - test.yml's four `Integration <engine> <mode>` jobs, on
# amd64 only, since Playwright ships no WebKit build for aarch64. It covers the
# wiring between browser, xterm.js, ttyd and tmux that unit tests cannot see -
# every mouse/clipboard bug of 2.7.0-2.7.4 lived there and passed CI. Runs both
# WebKit and Chromium, against the direct port AND an ingress-shaped harness;
# CTP_ENGINE=webkit|chromium and CTP_MODE=direct|ingress narrow it to one.
# Needs the stub Supervisor running, as above.
docker run -d --name ctp -p 7680:7680 \
  -e SUPERVISOR_API=http://host.docker.internal:8099 \
  --add-host=host.docker.internal:host-gateway local/claude-terminal-prowine
mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright && npx playwright install webkit chromium)
CTP_PLAYWRIGHT=/tmp/pw/node_modules/playwright/index.mjs \
  node claude-terminal/wrapper/test/integration/mouse-and-clipboard.mjs
```

Startup-script helpers are unit-tested — `run.sh` and `health-check.sh` guard
their entrypoints with `[ "${BASH_SOURCE[0]}" = "${0}" ]` so tests can source
them. Keep that guard when editing either file, and note that `bashio::log.*`
writes to `$LOG_FD` rather than stdout: a helper whose result is read via
command substitution must never have its log output redirected to stdout.

### Linting (run from repo root)
```bash
hadolint claude-terminal/Dockerfile
shellcheck --external-sources claude-terminal/run.sh claude-terminal/scripts/*.sh \
  claude-terminal/scripts/persist-install tests/*.sh test-wrapper-integration.sh
yamllint -c .yamllint.yml claude-terminal/config.yaml claude-terminal/translations/ \
  .trivy.yaml .trivyignore.yaml .github/workflows/
actionlint
(cd claude-terminal/wrapper && npm ci && npm run lint)   # ESLint (wrapper JS)
ruff check                                                # Python (tools/)
```

## Architecture

### App Structure (claude-terminal/)
- **config.yaml** — App configuration (slug: `claude_terminal_prowine`); declares the multi-arch `image:` pull location
- **translations/en.yaml** — Configuration-tab label and help text for every option, and the Network tab's port warning. A new option needs an entry; `tests/test-translations.sh` fails without one
- **Dockerfile** — Alpine container with Node.js and Claude Code CLI; sets the base image (digest-pinned `ghcr.io/home-assistant/base`, Renovate-managed) and the OCI labels formerly in build.yaml
- **run.sh** — Startup script: health check → environment init → tools → services → terminal
- **scripts/** — Modular credential management scripts
- **ha-mcp/** — Home Assistant MCP server with locked dependencies (`pyproject.toml` + `uv.lock`)
- **wrapper/** — Express.js server (port 7680): image uploads, terminal proxy, OSC 52 clipboard delivery
  - **public/** — HTML interface, PWA assets (manifest, service worker, icons, offline fallback)

### Key Components
1. **Web Terminal** — ttyd (v1.7.7) browser-based terminal
2. **Wrapper Service** — Express.js handling UI, WebSocket proxy to ttyd, image uploads, clipboard button
3. **Credential Management** — Claude Code keeps its login in `~/.claude/.credentials.json` and `~/.claude.json` under `HOME=/data/home` (it reads `CLAUDE_CONFIG_DIR`, unset, falling back to `~/.claude`). run.sh migrates legacy credentials there copy-if-absent, once per source, and holds both files at 600 every boot
4. **Package Management** — Persistent installation via `persist-install` to `/data/packages/`
5. **Home Assistant MCP** — Pre-installed ha-mcp server with locked dependencies
6. **PWA** — Installable to home screens; relative URLs work across direct port, ingress, and reverse proxy

### Wrapper Service Gotchas
- **WebSocket pathRewrite** is required: `'^/terminal': ''` — without it, ttyd rejects with "illegal ws path"
- **Middleware order matters**: API routes → terminal proxy → static files → error handler
- **WebSocket upgrades bypass Express.** They are dispatched from the http server's `upgrade` event, so no Express middleware sees them — the origin check for the terminal socket is `createUpgradeGuard` (`http-guards.js`), called in that handler. ttyd binds `127.0.0.1` only, so the wrapper is the single way in; do not rebind it to `0.0.0.0`. ttyd's own `--check-origin` is no substitute: the proxy's `changeOrigin` rewrites Host before ttyd sees it
- **The wrapper runs under `supervise()` in run.sh**, which restarts it with capped back-off. Nothing else would: config.yaml has no `watchdog:`, and ttyd keeps the container "running" without it. Still, code on event-listener paths (the proxy's `on.error`, see `proxy-error.js`) must never throw — an exception there is uncaught and costs every open session a restart
- **PWA cache version** (`CACHE_NAME` in `sw.js`) must be manually bumped when cached assets change
- **Bumping `CACHE_NAME` is not enough on its own.** It invalidates the *service worker* cache only; the browser's HTTP cache sits underneath and is untouched by it. `cache-policy.js` sends `no-cache` for the shell so assets revalidate. Without that, Safari served a user 2.7.0 JavaScript against 2.7.1 HTML for an entire release

### Mouse ownership — do not re-litigate

**Rule: tmux is the sole authority over mouse reporting. The browser must not arbitrate it.**

Why the obvious alternative fails:

1. An application asks for the mouse with a DECSET on the PTY
2. To keep text selection working, the wrapper used to veto that request
3. The veto was gated on a flag set by the `/mouse-mode` HTTP response
4. Nothing orders an HTTP response against PTY bytes, so the veto ate the sequences that enabled scrolling
5. tmux caches its tty mode, so it never re-sent them — leaving mouse mode dead until a page reload
6. It shipped broken through three releases before the design was replaced

What replaced it, and what not to undo:

| do | instead of |
|---|---|
| let xterm's `macOptionClickForcesSelection` handle selection while reporting is on (Option on macOS, Shift elsewhere) | vetoing applications' DECSET |
| let tmux route the wheel to whoever asked for the mouse | detecting which program is running |
| change `tmux_mouse_mode`, or `Prefix + m` for a live flip | adding a browser-side control |

Never set `CLAUDE_CODE_DISABLE_MOUSE`. It suppresses Claude Code's mouse request,
which is exactly what routes the wheel to the session — with it set, tmux takes the
wheel and scrolls pane history instead. This was a real regression in 2.7.3, fixed
in 2.7.4.

## Conventions

### File Standards
- **Shell Scripts**: `#!/command/with-contenv bashio`, 4-space indent, `bashio::log.error` for errors
- **YAML**: 2-space indent
- **Credentials**: 600 file permissions

### Commit Messages
- **Conventional Commits** format required: `type: description` or `type(scope): description`
- Common types: `feat`, `fix`, `deps`, `chore`, `docs`, `refactor`, `ci`, `perf`, `test`
- Only `feat`, `fix`, `deps`, `perf`, and `revert` trigger releases

### Key Environment Variables
- `ANTHROPIC_CONFIG_DIR=/data/.config/claude` — read by Claude Code only for SDK credential profiles, not as its config dir; see Credential Management
- `HOME=/data/home` — Persistent home directory
- `SUPERVISOR_TOKEN` — HA Supervisor API token
- `WRAPPER_PORT=7680` / `TTYD_PORT=7681` — Service ports (ttyd on loopback only)
- `XDG_CONFIG_HOME=/data/.config`, `XDG_CACHE_HOME=/data/.cache`, `XDG_STATE_HOME=/data/.local/state`, `XDG_DATA_HOME=/data/.local/share`

### Important Constraints
- No sudo in dev environment; targets Alpine Linux 3.24
- Multi-architecture: amd64 + aarch64
- **CRITICAL:** `wrapper/package-lock.json` must be committed (deterministic npm builds)
- **CRITICAL:** `ha-mcp/uv.lock` must be committed (deterministic Python builds)
- Docker builds require `--no-cache` when npm or Python dependencies change
- Credential persistence must survive container restarts. Never overwrite a live login (`~/.claude/.credentials.json`) from a legacy source, and never restore one after the user's `/logout` — `migrate_legacy_auth_files` enforces both

### Docker Socket Access (optional feature)

Two new app options (both default `false`):
- `enable_docker` — installs `docker-cli` + `docker-cli-compose` via `persist-install` at startup and expects the host Docker socket at `/run/docker.sock`
- `enable_docker_buildx` — additionally installs `docker-cli-buildx`; only meaningful when `enable_docker` is also `true`

The manifest sets `docker_api: true`, but this is **inert while Protection Mode is ON** (the HA Supervisor default). The socket is only bind-mounted into the container when the user disables Protection Mode in the app's **Info** tab. Both the config option AND the Protection Mode toggle are required — neither alone is sufficient.

The Docker CLI packages are installed via `persist-install` (unpinned, floats to current Alpine repo version) and are not tracked by Renovate — consistent with how `persistent_apk_packages` behaves. Docker socket access is effectively root on the host; it compounds with `dangerously_skip_permissions`.

**AppArmor:** Verified on a live HA install (v2.4.0) that Docker socket access works with AppArmor left **enabled** (default) — disabling Protection Mode alone is sufficient. No `apparmor: false` or custom AppArmor profile is required, so the syscall sandbox stays intact for all other operations.

## Dependency Management

### Updating npm dependencies (wrapper/)
```bash
cd claude-terminal/wrapper && npm install
git add package-lock.json
```
Note: `.gitignore` has a specific exception for `!claude-terminal/wrapper/package-lock.json`.

### Updating ha-mcp dependencies
```bash
docker run --rm --entrypoint bash \
  -v $(pwd)/claude-terminal/ha-mcp:/opt/ha-mcp \
  ghcr.io/home-assistant/base:3.24 -c \
  'apk add --no-cache curl > /dev/null 2>&1 && \
   curl -fsSL https://astral.sh/uv/install.sh | sh > /dev/null 2>&1 && \
   export PATH="$HOME/.local/bin:$PATH" && \
   cd /opt/ha-mcp && uv lock'
git add claude-terminal/ha-mcp/uv.lock
```
Note: Renovate auto-tracks both `pyproject.toml` + `uv.lock`. Manual updates rarely needed.

### Renovate
- Auto-merges patch updates; groups minor updates; individual PRs for major
- Tracks npm, Docker, GitHub Actions, Python (uv), and Alpine apk dependencies
- All GitHub Actions use SHA256 digest pinning (Renovate auto-updates)
- Alpine packages in `Dockerfile` are pinned to exact versions; Renovate's dockerfile manager extracts those `apk add` pins natively (datasource `apk`)
- The HA base image (`ghcr.io/home-assistant/base`) is pinned to a tag + digest in the Dockerfile `BUILD_FROM` ARG and tracked by Renovate's built-in dockerfile manager (digest auto-updated)
- **IMPORTANT:** When bumping the Alpine base image (e.g., 3.24 → 3.25), you must also update `branch=v3.24` → `branch=v3.25` in the apk `registryUrls` packageRule in `renovate.json` — otherwise Renovate will look up versions from the wrong Alpine release
- See `renovate.json` for config

## Release Management

### Conventional Commits

All commits to `main` must use [Conventional Commits](https://www.conventionalcommits.org/) format. [release-drafter](https://github.com/release-drafter/release-drafter) sorts merged PRs by the type in the **PR title** to draft release notes and the version bump. Its config is shared fleet-wide: `.github/release-drafter.yml` only `_extends` `owine/renovate-config:/release-drafter.yml` — change categories there, not here.

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `feat:` | Minor (x.Y.0) | `feat: add persistent tmux sessions` |
| `fix:` | Patch (x.x.Z) | `fix: restore iOS scrolling` |
| `deps:` | Patch (x.x.Z) | `deps: update express to v5` (Renovate) |
| `perf:` | Patch (x.x.Z) | `perf: reduce container startup time` |
| `revert:` | Patch (x.x.Z) | `revert: restore the old clipboard path` |
| `!` after the type, **in the title** | Major (X.0.0) | `feat!: drop the legacy auth path` |
| `chore:`, `docs:`, `ci:`, `test:`, `refactor:`, `build:`, `style:` | No release | Left out of the notes entirely |
| anything else (non-conventional title) | Patch (x.x.Z) | Listed unsectioned at the top of the notes |

A `BREAKING CHANGE:` footer is **ignored** — release-drafter reads only the PR title, so put the `!` there.

### Release Process

Do **not** manually bump `config.yaml` version or edit `CHANGELOG.md` — automation handles both.

1. Open a PR with a Conventional Commits title, and squash-merge it into `main`
2. `release-drafter.yml` refreshes the single **draft** GitHub Release on every push to `main`
3. When ready to release, a human reviews and publishes that draft in the GitHub UI (it creates the `vX.Y.Z` tag)
4. `publish.yml` triggers on `release: published` → builds, signs, and pushes Docker images
5. Once the multi-arch manifest is pushed, `publish.yml`'s `promote` job commits
   `chore: publish X.Y.Z to Home Assistant` to `main`: the `config.yaml` version bump
   and the release's notes prepended to `CHANGELOG.md`, in one signed commit

Supervisor reads `config.yaml` from `main`, so that bump is the moment HA offers the update,
and it shows `CHANGELOG.md` alongside it — one commit means HA never sees a version without
its changelog, or a version whose image isn't pullable yet.
`promote` only moves the version forward, so re-running an older release's publish is safe;
it then skips the CHANGELOG too. The CHANGELOG entry is the **release body as published**, so
edit the draft's notes before publishing, not the file afterwards.

- **A draft always exists.** If only hidden types merged since the last release it reads
  `_No user-facing changes._` — don't publish that one.
- **Never publish with `GITHUB_TOKEN`** (no `publish: true` in release-drafter): a release
  published by that token fires no `release: published` run, so nothing would build.
- **Don't retarget the draft to an older commit.** `release: published` runs the workflow
  files at the tagged commit, and the draft targets `main` for that reason.

**`main` does not accept direct pushes.** The `main protection` ruleset requires a pull
request plus 5 passing status checks (`Lint all`, `Unit tests`, `Test build amd64`,
`Test build aarch64`, `Integration tests`), and enforces linear history — so merge commits are disabled and only
squash or rebase merges are available. Branch before committing. The one automated bypass
actor is the `claude-terminal-release-bot` app, for `promote`'s version commit only
(made with GraphQL `createCommitOnBranch`, which GitHub signs, against an `expectedHeadOid`).
Its secrets (`RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`) live in the `release`
environment, which only releases them to jobs on `main` or a `v*` tag (a `release: published`
run is on its tag, so `promote` qualifies); any job that mints
the app token must declare `environment: {name: release, deployment: false}`.
A tag ruleset (`release tags`) lets only the bot and Admin create, move or delete `v*` tags,
since a tag's own `publish.yml` would otherwise run with those secrets.

release-drafter reads the **PR title**, and squash-merging makes that title the commit
subject on `main` too, so the title is the one thing that must carry the Conventional Commits
prefix. Retitling a merged PR re-sorts it on the next draft refresh.

A **rebase merge** is sorted the same way: release-drafter finds PRs through each commit's
associated pull requests, which GitHub keeps for rebased commits (verified on #351), and lists
the PR once by its title. What differs is `main`'s history: it gets the PR's own commits, not
its title, so each commit message must stand on its own and carry a Conventional Commits
prefix. Prefer it for a PR whose commits are deliberately separate. Whether GitHub's
rebase-and-merge keeps commits signed is unverified here; check the first one, or squash.

```bash
# Inspect the current draft, and verify a release
gh release list --limit 3
gh run list --workflow=publish.yml --limit 3
```

### CI/CD Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `release-drafter.yml` | Push to main, manual | Refresh the draft GitHub Release (notes + next version) |
| `test.yml` | Push to main, PRs | Unit tests (shell + wrapper JS), build validation (init → per-arch native builds + smoke test, no QEMU), and the browser integration test as four parallel amd64 jobs summarised by `Integration tests`. On a PR touching nothing under `claude-terminal/`, `tests/` or test.yml, the build, smoke and browser steps skip while the required checks still report |
| `lint.yml` | Push/PR to main | hadolint, shellcheck, yamllint, actionlint, ESLint, Ruff |
| `publish.yml` | Release published | Build + sign + push images, then bump `config.yaml` + prepend `CHANGELOG.md` on main (init → per-arch → manifest → promote + scan) |
| `security.yml` | Push/PR to main + weekly cron | Trivy filesystem security scan; opens tracking issue on findings |
| `claude.yml` | @claude mentions | Respond to mentions in issues/PRs (optional) |

**Images:** `ghcr.io/owine/{arch}-claude-terminal-prowine:{version|latest}` and multi-arch manifest at `ghcr.io/owine/claude-terminal-prowine`

## Persistent Package Management

**ALWAYS use `persist-install` instead of `apk add` or `pip install`** — direct installs are lost on restart.

```bash
persist-install python3 py3-pip git    # System packages
persist-install --python requests      # Python packages
persist-install --list                 # Show installed
```

System packages persist as a recorded list (`/data/packages/world`) plus apk's download cache (`/data/packages/apk-cache`, backup-excluded); `run.sh` replays the list through apk at every start, so each comes back complete with its dependencies. Python packages live in the venv at `/data/packages/python/venv`. Auto-install via app config: `persistent_apk_packages` and `persistent_pip_packages` lists, installed `--no-record` so the option stays their only record. `/data/packages/bin|lib|libexec` are leftovers of the old copy-based version: last on `PATH`, never on `LD_LIBRARY_PATH`, migrated once by `persist-install --migrate-legacy`.

See `claude-terminal/PERSISTENT_PACKAGES.md` for full details.

## Task Completion

When reviewing PRs, complete the full review cycle — summarize findings, provide actionable feedback, confirm next steps.

## Documentation

For cleanup tasks: 1) List files to modify/delete, 2) Get user approval, 3) Process in batches.

## Design & Planning

During design discussions, create a running summary document capturing decisions so progress isn't lost if session ends.
