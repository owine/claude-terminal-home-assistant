# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Terminal Prowine** — a Home Assistant add-on providing a web-based terminal with Claude Code CLI pre-installed and persistent package management.

**Fork Attribution:** Personal fork by [@owine](https://github.com/owine), built upon:
- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) - Original by Tom Cassady
- [ESJavadex/claude-code-ha](https://github.com/ESJavadex/claude-code-ha) - Enhanced fork by Javier Santos

## Development Environment

### Setup
```bash
nix develop        # Enter development shell
direnv allow       # Or with direnv
```

### Commands
```bash
# Build & Test (Nix shell)
build-addon        # Build with Podman
run-addon          # Run locally on port 7681
test-endpoint      # curl localhost:7681

# Linting
lint-all           # All linters (hadolint, shellcheck, yamllint, actionlint)
lint-dockerfile    # hadolint
lint-shell         # shellcheck
lint-yaml          # yamllint
lint-actions       # actionlint

# Manual build (replace {arch} with amd64 or aarch64)
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 \
  -t local/claude-terminal-prowine ./claude-terminal
# Add --no-cache when dependencies change
```

## Architecture

### App Structure (claude-terminal/)
- **config.yaml** — Add-on configuration (slug: `claude_terminal_prowine`)
- **Dockerfile** — Alpine 3.23 container with Node.js and Claude Code CLI
- **build.yaml** — Multi-arch build config (amd64, aarch64) with Renovate-tracked base images
- **run.sh** — Startup script: health check → environment init → tools → services → terminal
- **scripts/** — Modular credential management scripts
- **ha-mcp/** — Home Assistant MCP server with locked dependencies (`pyproject.toml` + `uv.lock`)
- **wrapper/** — Express.js server (port 7680): image uploads, terminal proxy, mouse mode toggle
  - **public/** — HTML interface, PWA assets (manifest, service worker, icons, offline fallback)

### Key Components
1. **Web Terminal** — ttyd (v1.7.7) browser-based terminal
2. **Wrapper Service** — Express.js handling UI, WebSocket proxy to ttyd, image uploads, mouse toggle
3. **Credential Management** — Persistent auth storage in `/data/.config/claude/` with 600 permissions
4. **Package Management** — Persistent installation via `persist-install` to `/data/packages/`
5. **Home Assistant MCP** — Pre-installed ha-mcp server with locked dependencies
6. **PWA** — Installable to home screens; relative URLs work across direct port, ingress, and reverse proxy

### Wrapper Service Gotchas
- **WebSocket pathRewrite** is required: `'^/terminal': ''` — without it, ttyd rejects with "illegal ws path"
- **Middleware order matters**: API routes → terminal proxy → static files → error handler
- **PWA cache version** (`CACHE_NAME` in `sw.js`) must be manually bumped when cached assets change

## Conventions

### File Standards
- **Shell Scripts**: `#!/usr/bin/with-contenv bashio`, 4-space indent, `bashio::log.error` for errors
- **YAML**: 2-space indent
- **Credentials**: 600 file permissions

### Commit Messages
- **Conventional Commits** format required: `type: description` or `type(scope): description`
- Common types: `feat`, `fix`, `deps`, `chore`, `docs`, `refactor`, `ci`, `perf`, `test`
- Only `feat`, `fix`, `deps`, `perf`, and `revert` trigger releases

### Key Environment Variables
- `ANTHROPIC_CONFIG_DIR=/data/.config/claude` — Claude config
- `HOME=/data/home` — Persistent home directory
- `SUPERVISOR_TOKEN` — HA Supervisor API token
- `WRAPPER_PORT=7680` / `TTYD_PORT=7681` — Service ports
- `XDG_CONFIG_HOME=/data/.config`, `XDG_CACHE_HOME=/data/.cache`, `XDG_STATE_HOME=/data/.local/state`, `XDG_DATA_HOME=/data/.local/share`

### Important Constraints
- No sudo in dev environment; targets Alpine Linux 3.23
- Multi-architecture: amd64 + aarch64
- **CRITICAL:** `wrapper/package-lock.json` must be committed (deterministic npm builds)
- **CRITICAL:** `ha-mcp/uv.lock` must be committed (deterministic Python builds)
- Docker builds require `--no-cache` when npm or Python dependencies change
- Credential persistence must survive container restarts

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
  ghcr.io/home-assistant/aarch64-base:3.23 -c \
  'apk add --no-cache curl > /dev/null 2>&1 && \
   curl -fsSL https://astral.sh/uv/install.sh | sh > /dev/null 2>&1 && \
   export PATH="$HOME/.local/bin:$PATH" && \
   cd /opt/ha-mcp && uv lock'
git add claude-terminal/ha-mcp/uv.lock
```
Note: Renovate auto-tracks both `pyproject.toml` + `uv.lock`. Manual updates rarely needed.

### Renovate
- Auto-merges patch updates; groups minor updates; individual PRs for major
- Tracks npm, Docker, GitHub Actions, Python (uv), and Alpine apk (Repology) dependencies
- All GitHub Actions use SHA256 digest pinning (Renovate auto-updates)
- Alpine packages in `Dockerfile` are pinned to exact versions; Renovate tracks them via the Repology datasource
- **IMPORTANT:** When bumping the Alpine base image (e.g., 3.23 → 3.24), you must also update `depNameTemplate` in `renovate.json` from `alpine_3_23/{{package}}` to `alpine_3_24/{{package}}` — otherwise Renovate will look up versions from the wrong Alpine release
- See `renovate.json` for config

## Release Management

### Conventional Commits

All commits to `main` must use [Conventional Commits](https://www.conventionalcommits.org/) format. release-please uses these to determine version bumps and generate changelogs automatically.

| Prefix | Version bump | Example |
|--------|-------------|---------|
| `feat:` | Minor (x.Y.0) | `feat: add persistent tmux sessions` |
| `fix:` | Patch (x.x.Z) | `fix: restore iOS scrolling` |
| `deps:` | Patch (x.x.Z) | `deps: update express to v5` (Renovate) |
| `perf:` | Patch (x.x.Z) | `perf: reduce container startup time` |
| `BREAKING CHANGE` footer | Major (X.0.0) | Any type with breaking change footer |
| `chore:`, `docs:`, `ci:`, etc. | No release | Not releasable — included if bundled with releasable commits |

### Release Process

Releases are managed by [release-please](https://github.com/googleapis/release-please). Do **not** manually bump `config.yaml` version or edit `CHANGELOG.md` — release-please handles both.

1. Push commits to `main` using Conventional Commits format
2. release-please automatically creates/updates a Release PR with version bump + changelog
3. Merge the Release PR when ready to release
4. `publish.yml` triggers automatically → builds, signs, and pushes Docker images

```bash
# Verify release
gh run list --workflow=publish.yml --limit 3
```

### CI/CD Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `release-please.yml` | Push to main | Maintain Release PR (version bump + changelog) |
| `test.yml` | Push to main, PRs | Validate builds (2-job: init → per-arch native builds, no QEMU) |
| `lint.yml` | Push/PR to main | hadolint, shellcheck, yamllint, actionlint |
| `publish.yml` | Release published | Build + sign + push images (4-job: init → per-arch → manifest → scan) |
| `claude-code-review.yml` | PR events | AI code review (optional) |
| `claude.yml` | @claude mentions | Respond to mentions in issues/PRs (optional) |

**Images:** `ghcr.io/owine/{arch}-claude-terminal-prowine:{version|latest}` and multi-arch manifest at `ghcr.io/owine/claude-terminal-prowine`

## Persistent Package Management

**ALWAYS use `persist-install` instead of `apk add` or `pip install`** — direct installs are lost on restart.

```bash
persist-install python3 py3-pip git    # System packages
persist-install --python requests      # Python packages
persist-install --ha-cli               # Home Assistant CLI
persist-install --list                 # Show installed
```

Packages persist to `/data/packages/` (bin, lib, python venv). Auto-install via add-on config: `persistent_apk_packages` and `persistent_pip_packages` lists.

See `claude-terminal/PERSISTENT_PACKAGES.md` for full details.

## Task Completion

When reviewing PRs, complete the full review cycle — summarize findings, provide actionable feedback, confirm next steps.

## Documentation

For cleanup tasks: 1) List files to modify/delete, 2) Get user approval, 3) Process in batches.

## Design & Planning

During design discussions, create a running summary document capturing decisions so progress isn't lost if session ends.
