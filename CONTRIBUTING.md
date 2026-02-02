# Contributing to Claude Terminal Prowine

Thank you for your interest in contributing! This guide will help you get started.

## Getting Started

### Prerequisites

- **Git** - Version control
- **Docker or Podman** - Container runtime for testing
- **Nix** (optional) - For development environment with all tools
- **Home Assistant** (optional) - For integration testing

### Development Setup

```bash
# Clone the repository
git clone https://github.com/owine/claude-terminal-home-assistant.git
cd claude-terminal-home-assistant

# Option 1: Use Nix development shell (recommended)
nix develop

# Option 2: Install tools manually
brew install hadolint shellcheck yamllint actionlint
```

See [CLAUDE.md](./CLAUDE.md) for comprehensive development documentation.

## Development Workflow

### 1. Local Testing

Before submitting changes, always test locally:

```bash
# Build the add-on (replace {arch} with amd64 or aarch64)
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 \
  -t local/claude-terminal:test ./claude-terminal

# Run locally
docker run -d --name test-claude-dev -p 7681:7681 \
  -v $(pwd)/config:/config local/claude-terminal:test

# Test in browser
open http://localhost:7681

# Check logs
docker logs test-claude-dev

# Cleanup
docker stop test-claude-dev && docker rm test-claude-dev
```

### 2. Run Linters

All code must pass linting before being merged:

```bash
# Run all linters
lint-all

# Or individually
lint-dockerfile   # Dockerfile
lint-shell        # Shell scripts
lint-yaml         # YAML files
lint-actions      # GitHub Actions
```

CI will automatically run these on all PRs.

### 3. Update Documentation

**CRITICAL:** When making changes, always update:

1. **Version number** in `claude-terminal/config.yaml`
2. **Changelog** in `claude-terminal/CHANGELOG.md` (add entry at top)
3. **Documentation** if behavior changes

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
5. **Update docs** - Add CHANGELOG entry, update version
6. **Push and create PR** with clear description

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

- Use `#!/usr/bin/with-contenv bashio` for add-on scripts
- Include descriptive comments for complex logic
- Use `bashio::log.*` for logging
- Handle errors gracefully with proper exit codes

### Dockerfile

- Follow Home Assistant add-on conventions
- Use Alpine base images from `build.yaml`
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
├── config.yaml           # Add-on configuration
├── Dockerfile            # Container definition
├── build.yaml            # Multi-arch build config
├── run.sh                # Main startup script
├── scripts/              # Modular functionality scripts
│   ├── health-check.sh
│   ├── claude-session-picker.sh
│   └── ...
└── image-service/        # Express.js image upload service
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

- [ ] Add-on builds successfully for both amd64 and aarch64
- [ ] Web interface loads at http://localhost:7681
- [ ] Claude authentication works
- [ ] Session picker displays correctly (if applicable)
- [ ] Persistent packages install correctly (if applicable)
- [ ] No errors in container logs
- [ ] Configuration options work as expected

### Automated Testing

- Linting runs automatically on all PRs
- Test workflow validates builds for all architectures
- Check GitHub Actions results before requesting review

## Common Issues

### Build Failures

**Problem:** `Dockerfile` build fails with dependency errors

**Solution:** Use `--no-cache` flag when dependencies change:
```bash
docker build --no-cache \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 \
  -t local/claude-terminal:test ./claude-terminal
```

### Authentication Not Persisting

**Problem:** Claude credentials lost after restart

**Solution:** Check credential files exist in `/data/.config/claude/`
- Verify `run.sh` creates directories correctly
- Check file permissions (should be 600)

### Linting Failures

**Problem:** CI fails on shellcheck or hadolint

**Solution:** Run linters locally before pushing:
```bash
lint-all  # Fix any issues reported
```

## Getting Help

- **Documentation:** Read [CLAUDE.md](./CLAUDE.md) for comprehensive guide
- **Issues:** Check [GitHub Issues](https://github.com/owine/claude-terminal-home-assistant/issues)
- **Discussions:** Ask questions in GitHub Discussions
- **Linting Guide:** See [.github/LINTING.md](./.github/LINTING.md)

## Release Process

**Note:** Only maintainers create releases.

1. Bump version in `config.yaml`
2. Add entry to `CHANGELOG.md`
3. Commit changes
4. Create GitHub release (triggers automatic build & publish)

Pre-built images are published to GitHub Container Registry with cosign signatures.

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
