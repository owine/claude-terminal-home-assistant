# Linting Guide

This repository uses comprehensive linting to maintain code quality and consistency.

## Automated CI Linting

All linting runs automatically on every push and pull request via `.github/workflows/lint.yml`:

- **hadolint** - Dockerfile best practices (via action)
- **shellcheck** - Shell script analysis (pre-installed on runners)
- **yamllint** - YAML file validation (pre-installed on runners)
- **actionlint** - GitHub Actions workflow validation (via action)

**Note:** shellcheck and yamllint use the pre-installed versions on GitHub Actions runners, reducing external dependencies and improving CI speed.

## Local Development

### Prerequisites

Install linters via Homebrew:
```bash
brew install hadolint shellcheck yamllint actionlint
```

Or use the Nix development shell (installs automatically):
```bash
nix develop
```

### Running Linters

```bash
# Run all linters at once
lint-all

# Run individual linters
lint-dockerfile   # Lint Dockerfile
lint-shell        # Lint shell scripts
lint-yaml         # Lint YAML files
lint-actions      # Lint GitHub Actions workflows
```

### Manual Commands

```bash
# Dockerfile
hadolint -c .hadolint.yaml claude-terminal/Dockerfile

# Shell scripts
shellcheck claude-terminal/run.sh claude-terminal/scripts/*.sh

# YAML files
yamllint -c .yamllint.yml claude-terminal/config.yaml claude-terminal/build.yaml .github/workflows/

# GitHub Actions
actionlint
```

## Configuration Files

- `.hadolint.yaml` - Dockerfile linting rules (ignores DL3018 for HA add-ons)
- `.shellcheckrc` - Shell script linting rules (handles bashio shebang)
- `.yamllint.yml` - YAML formatting rules (120 char lines, 2-space indent)

## Severity Levels

**CI will fail on:**
- Dockerfile errors (not warnings)
- Shell script errors (not warnings)
- YAML errors (not warnings)
- GitHub Actions errors

**Warnings are reported but don't fail CI** to balance code quality with pragmatic development.

## Common Issues

### hadolint DL3018 (Ignored)

```dockerfile
RUN apk add --no-cache nodejs
```

This warning about pinning apk versions is ignored because Home Assistant base images manage package versions.

### shellcheck SC1008 (Ignored)

```bash
#!/usr/bin/with-contenv bashio
```

This shebang is specific to Home Assistant add-ons and is treated as bash by our configuration.

### yamllint line-length

Keep lines under 120 characters where practical. Long URLs and specific configuration values are acceptable.

## Best Practices

1. **Run linters locally** before committing
2. **Fix errors** immediately (CI will fail)
3. **Consider warnings** but don't obsess over them
4. **Update configs** if linter rules conflict with project needs

## Integration with Development Workflow

The linting workflow is designed to:
- Catch common mistakes early
- Enforce consistent code style
- Validate configuration files
- Prevent deployment of broken code

Linters are **advisory tools**, not strict gatekeepers. The goal is maintainable, high-quality code—not perfect linter scores.
