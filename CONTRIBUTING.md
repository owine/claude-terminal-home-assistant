# Contributing to Claude Terminal Prowine

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- **Git** - Version control
- **Docker** - Container runtime for testing
- **Nix** (optional) - For development environment with all tools
- **Home Assistant** (optional) - For integration testing

### Development Setup

```bash
# Clone the repository
git clone https://github.com/owine/claude-terminal-home-assistant.git
cd claude-terminal-home-assistant

# Install the toolchain (macOS via Homebrew)
brew install hadolint shellcheck yamllint actionlint ruff node
# Plus Docker (container runtime)
```

See [CLAUDE.md](./CLAUDE.md) for comprehensive development documentation.

## Development Workflow

### 1. Local Testing

Before submitting changes, always test locally:

```bash
# Build the app (replace {arch} with amd64 or aarch64)
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.24 \
  -t local/claude-terminal:test ./claude-terminal

# Run locally (7680 = web UI/ingress, 7681 = internal ttyd)
docker run -d --name test-claude-dev -p 7680:7680 -p 7681:7681 \
  -v $(pwd)/config:/config local/claude-terminal:test

# Test in browser
open http://localhost:7680

# Check logs
docker logs test-claude-dev

# Cleanup
docker stop test-claude-dev && docker rm test-claude-dev
```

### 2. Run Linters

All code must pass linting before being merged. Run from the repo root:

```bash
hadolint claude-terminal/Dockerfile                       # Dockerfile
shellcheck --external-sources claude-terminal/run.sh \
  claude-terminal/scripts/*.sh claude-terminal/scripts/persist-install \
  test-wrapper-integration.sh                             # Shell scripts
yamllint -c .yamllint.yml claude-terminal/config.yaml \
  .trivy.yaml .github/workflows/  # YAML files
actionlint                                                # GitHub Actions
(cd claude-terminal/wrapper && npm ci && npm run lint)    # ESLint (wrapper JS)
ruff check                                                # Python (tools/)
```

CI will automatically run these on all PRs.

### 3. Update Documentation

When your change affects behavior, update the relevant prose docs (e.g. `CLAUDE.md`, `claude-terminal/DOCS.md`, `README.md`).

**Do not** manually bump the version in `claude-terminal/config.yaml` or add a `CHANGELOG.md` entry — those are generated automatically. release-please derives the version bump and changelog from your [Conventional Commits](https://www.conventionalcommits.org/) when maintainers merge the Release PR.

See [CLAUDE.md - Release Management](./CLAUDE.md#release-management) for details.

## Making Changes

### Branch Naming

Use descriptive branch names:
- `feat/session-picker` - New features
- `fix/auth-persistence` - Bug fixes
- `docs/update-readme` - Documentation updates
- `refactor/cleanup-scripts` - Code refactoring

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add support for custom Claude flags
fix: resolve credential persistence issue
docs: update installation instructions
refactor: consolidate duplicate code
chore: update dependencies
```

**Examples:**
```bash
git commit -m "feat: add tmux mouse mode configuration option"
git commit -m "fix: correct config.yaml schema validation error"
git commit -m "docs: clarify persistent package installation"
```

### Pull Request Process

1. **Create a feature branch** from `main`
2. **Make your changes** with clear commits
3. **Test locally** - Verify changes work
4. **Run linters** - Ensure code passes all checks
5. **Update docs** - Update prose docs if behavior changed (version + CHANGELOG are automated)
6. **Push and create PR** with clear description using Conventional Commits

**PR Description Should Include:**
- What changes were made and why
- How to test the changes
- Any breaking changes or migration steps
- Screenshots/logs if relevant

### Code Review

- All PRs require review before merging
- Address review feedback promptly
- Be open to suggestions and improvements
- Maintain a respectful, collaborative tone

## Code Standards

### Shell Scripts

- Use `#!/usr/bin/with-contenv bashio` for app scripts
- Include descriptive comments for complex logic
- Use `bashio::log.*` for logging
- Handle errors gracefully with proper exit codes

### Dockerfile

- Follow Home Assistant app conventions
- Base image is digest-pinned in the Dockerfile (`ghcr.io/home-assistant/base`)
- Minimize layers where practical
- Document complex RUN commands

### YAML Files

- 2-space indentation
- Keep lines under 120 characters
- Use `---` document start marker
- Include trailing newline

### Documentation

- Keep CLAUDE.md as the primary developer guide
- User-facing docs go in `claude-terminal/DOCS.md`
- Use clear, concise language
- Include code examples where helpful

## Architecture Guidelines

### File Structure

```
claude-terminal/
├── config.yaml           # App configuration
├── Dockerfile            # Container definition
├── run.sh                # Main startup script
├── scripts/              # Modular functionality scripts
│   ├── health-check.sh
│   ├── claude-session-picker.sh
│   └── ...
└── wrapper/              # Express.js web wrapper (UI, proxy, uploads, mouse toggle)
    ├── server.js
    ├── package.json
    └── package-lock.json # CRITICAL: Must be committed
```

### Key Principles

1. **Single Responsibility** - Each script does one thing well
2. **Modularity** - Functionality in separate, testable scripts
3. **Error Handling** - Fail gracefully with clear messages
4. **Logging** - Use bashio logging for consistency
5. **Security** - Never log credentials, use proper permissions

## Testing

### Manual Testing Checklist

Before submitting a PR, verify:

- [ ] App builds successfully for both amd64 and aarch64
- [ ] Web interface loads at http://localhost:7680
- [ ] Claude authentication works
- [ ] Session picker displays correctly (if applicable)
- [ ] Persistent packages install correctly (if applicable)
- [ ] No errors in container logs
- [ ] Configuration options work as expected

### Automated Testing

All PRs trigger automated workflows:

**Linting** (`.github/workflows/lint.yml`)
- hadolint for Dockerfile
- shellcheck for shell scripts
- yamllint for YAML files
- actionlint for GitHub Actions

**Test Builds** (`.github/workflows/test.yml`)
- Builds for both amd64 and aarch64
- Builds each arch with `push: false` and runs a smoke test (no registry push)
- Validates build configuration before merge

Check GitHub Actions results before requesting review

## Common Issues

### Build Failures

**Problem:** `Dockerfile` build fails with dependency errors

**Solution:** Use `--no-cache` flag when dependencies change:
```bash
docker build --no-cache \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.24 \
  -t local/claude-terminal:test ./claude-terminal
```

### Authentication Not Persisting

**Problem:** Claude credentials lost after restart

**Solution:** Check credential files exist in `/data/.config/claude/`
- Verify `run.sh` creates directories correctly
- Check file permissions (should be 600)

### Linting Failures

**Problem:** CI fails on shellcheck or hadolint

**Solution:** Run the linters locally before pushing (see [Run Linters](#2-run-linters)) and fix any issues reported.

## Getting Help

- **Documentation:** Read [CLAUDE.md](./CLAUDE.md) for comprehensive guide
- **Issues:** Check [GitHub Issues](https://github.com/owine/claude-terminal-home-assistant/issues)
- **Discussions:** Ask questions in GitHub Discussions
- **Linting Guide:** See [.github/LINTING.md](./.github/LINTING.md)

## Release Process

Releases are fully automated by [release-please](https://github.com/googleapis/release-please) — no manual version bumps, changelog edits, or GitHub release creation.

1. Contributors merge Conventional Commits into `main`
2. release-please opens/updates a "Release PR" with the version bump + generated `CHANGELOG.md`
3. A maintainer merges the Release PR, which tags the release and triggers `publish.yml`
4. `publish.yml` builds, signs (cosign), and pushes multi-arch images to GitHub Container Registry

See [CLAUDE.md - Release Management](./CLAUDE.md#release-management) for details.

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Help others learn and grow
- Focus on what's best for the project

## Recognition

Contributors are recognized through:
- GitHub contributor list
- CHANGELOG.md mentions for significant features
- Co-Authored-By commits for AI-assisted contributions

---

Thank you for contributing to Claude Terminal Prowine! 🚀
