# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This repository contains Home Assistant add-ons, specifically the **Claude Terminal Prowine** add-on which provides a web-based terminal interface with Claude Code CLI pre-installed and persistent package management. The add-on allows Home Assistant users to access Claude AI capabilities directly from their dashboard.

**Fork Attribution:** This is a personal fork maintained by [@owine](https://github.com/owine), built upon:
- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) - Original Claude Terminal add-on by Tom Cassady
- [ESJavadex/claude-code-ha](https://github.com/ESJavadex/claude-code-ha) - Enhanced fork by Javier Santos

**Current Version:** v1.2.3

## Development Environment

### Setup
```bash
# Enter the development shell (NixOS/Nix)
nix develop

# Or with direnv (if installed)
direnv allow
```

### Core Development Commands

**Build & Test:**
- `build-addon` - Build the Claude Terminal Prowine add-on with Podman
- `run-addon` - Run add-on locally on port 7681 with volume mapping
- `test-endpoint` - Test web endpoint availability (curl localhost:7681)

**Linting:**
- `lint-all` - Run all linters (hadolint, shellcheck, yamllint, actionlint)
- `lint-dockerfile` - Lint Dockerfile using hadolint
- `lint-shell` - Lint all shell scripts using shellcheck
- `lint-yaml` - Lint YAML files using yamllint
- `lint-actions` - Lint GitHub Actions workflows using actionlint

### Manual Commands (for local testing)
```bash
# IMPORTANT: Replace {arch} with amd64 (x86_64) or aarch64 (ARM64/Apple Silicon)

# Build (use docker or podman)
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 \
  -t local/claude-terminal-prowine ./claude-terminal

# Build without cache (required when dependencies change)
docker build --no-cache \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 \
  -t local/claude-terminal-prowine ./claude-terminal

# Run locally
docker run -p 7681:7681 -v $(pwd)/config:/config local/claude-terminal-prowine

# Lint
hadolint ./claude-terminal/Dockerfile

# Test endpoint
curl -X GET http://localhost:7681/
```

## Architecture

### Add-on Structure (claude-terminal/)
- **config.yaml** - Home Assistant add-on configuration (slug: `claude_terminal_prowine`)
- **Dockerfile** - Alpine 3.23-based container with Node.js and Claude Code CLI
- **build.yaml** - Multi-architecture build configuration (amd64, aarch64)
- **run.sh** - Main startup script with credential management and ttyd terminal
- **scripts/** - Modular credential management scripts
- **image-service/** - Express.js server for image uploads and terminal proxy
  - **server.js** - Main service (port 7680)
  - **package.json** - Node.js dependencies (express 5.x, multer 2.x, http-proxy-middleware 3.x)
  - **package-lock.json** - **CRITICAL:** Ensures deterministic builds with exact dependency versions
  - **public/** - HTML interface with embedded ttyd terminal

### Key Components
1. **Web Terminal**: Uses ttyd (v1.7.7) to provide browser-based terminal access
2. **Image Service**: Express.js server handling image uploads and WebSocket proxying to ttyd
3. **Credential Management**: Persistent authentication storage in `/data/.config/claude/`
4. **Service Integration**: Home Assistant ingress support with panel icon
5. **Multi-Architecture**: Supports amd64, aarch64 platforms
6. **Package Management**: Persistent package installation via `persist-install` script

### Credential System
The add-on implements a sophisticated credential management system:
- **Persistent Storage**: Credentials saved to `/config/claude-config/` (survives restarts)
- **Multiple Locations**: Handles various Claude credential file locations
- **Background Service**: Continuous credential monitoring and saving
- **Security**: Proper file permissions (600) and safe directory operations

### Container Execution Flow
1. Run system health check (memory, disk, network, Node.js, Claude CLI)
2. Initialize environment in `/data` (home, config, cache directories)
3. Install ttyd and additional tools via apk
4. Setup persistent package management system
5. Configure Home Assistant MCP integration (if enabled)
6. Start image service on port 7680 (Express.js with WebSocket proxy)
7. Create tmux session for terminal persistence
8. Launch ttyd on port 7681 (attaches to tmux session)
9. Display session picker menu (if auto_launch_claude: false)

## Development Notes

### Local Container Testing
For rapid development and debugging without pushing new versions.

**IMPORTANT:** You must provide `--build-arg BUILD_FROM=...` because the Dockerfile has no default (this prevents multi-arch build issues).

#### Determine Your Architecture

```bash
# Check your system architecture
uname -m
# x86_64  → use amd64-base
# aarch64 → use aarch64-base (Apple Silicon, Raspberry Pi 4/5)
# arm64   → use aarch64-base (macOS reports as arm64)
```

#### Quick Build & Test

Use `docker` or `podman` (commands are interchangeable):

```bash
# For x86_64 / Intel / AMD systems:
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23 \
  -t local/claude-terminal:test ./claude-terminal

# For aarch64 / ARM64 / Apple Silicon systems:
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.23 \
  -t local/claude-terminal:test ./claude-terminal

# Build without cache (required after dependency changes):
docker build --no-cache \
  --build-arg BUILD_FROM=ghcr.io/home-assistant/aarch64-base:3.23 \
  -t local/claude-terminal:test ./claude-terminal

# Create test config directory
mkdir -p /tmp/test-config/claude-config

# Configure session picker (optional)
echo '{"auto_launch_claude": false}' > /tmp/test-config/options.json

# Run test container
docker run -d --name test-claude-dev -p 7681:7681 \
  -v /tmp/test-config:/config \
  local/claude-terminal:test

# Check logs
docker logs test-claude-dev

# Test web interface at http://localhost:7681

# Stop and cleanup
docker stop test-claude-dev && docker rm test-claude-dev
```

#### Interactive Testing
```bash
# Test session picker directly
docker run --rm -it local/claude-terminal:test /opt/scripts/claude-session-picker.sh

# Execute commands inside running container
docker exec -it test-claude-dev /bin/bash

# Test script modifications without rebuilding
docker cp ./claude-terminal/scripts/claude-session-picker.sh test-claude-dev:/opt/scripts/
docker exec test-claude-dev chmod +x /opt/scripts/claude-session-picker.sh
```

#### Development Workflow
1. **Make changes** to scripts or Dockerfile
2. **Rebuild** with `docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 -t local/claude-terminal:test ./claude-terminal`
3. **Stop/remove** old container: `docker stop test-claude-dev && docker rm test-claude-dev`
4. **Start new** container with updated image
5. **Test** changes at http://localhost:7681
6. **Repeat** until satisfied, then commit and push

**Note:** Replace `{arch}` with `amd64` or `aarch64` based on your system architecture.

#### Debugging Tips
- **Check container logs**: `docker logs -f test-claude-dev` (follow mode)
- **Inspect running processes**: `docker exec test-claude-dev ps aux`
- **Test individual scripts**: `docker exec test-claude-dev /opt/scripts/script-name.sh`
- **Volume contents**: `ls -la /tmp/test-config/` to verify persistence

### Production Testing
- **Local Testing**: Build and test locally before creating releases
- **Container Health**: Check logs with `docker logs <container-id>`
- **Authentication**: Use `claude-auth debug` within terminal for credential troubleshooting

### File Conventions
- **Shell Scripts**: Use `#!/usr/bin/with-contenv bashio` for add-on scripts
- **Indentation**: 2 spaces for YAML, 4 spaces for shell scripts
- **Error Handling**: Use `bashio::log.error` for error reporting
- **Permissions**: Credential files must have 600 permissions

### Key Environment Variables
- `ANTHROPIC_CONFIG_DIR=/data/.config/claude` - Claude Code configuration directory
- `HOME=/data/home` - User home directory (persistent across restarts)
- `SUPERVISOR_TOKEN` - Auto-populated token for Home Assistant Supervisor API
- `IMAGE_SERVICE_PORT=7680` - Image upload service port
- `TTYD_PORT=7681` - ttyd terminal port
- `UPLOAD_DIR=/data/images` - Directory for uploaded images

### Important Constraints
- No sudo privileges available in development environment
- Add-on targets Home Assistant OS (Alpine Linux 3.23 base)
- Must handle credential persistence across container restarts
- Requires multi-architecture compatibility (amd64, aarch64)
- **CRITICAL:** `image-service/package-lock.json` must be committed for deterministic builds
- Docker builds require `--no-cache` when npm dependencies change

## Release Management

### CRITICAL: Always Update Version and Changelog

**When making ANY changes to the add-on, you MUST:**

1. **Bump the version** in `claude-terminal/config.yaml`
   - Patch version (x.x.X) for bug fixes and small changes
   - Minor version (x.X.0) for new features
   - Major version (X.0.0) for breaking changes

2. **Update the changelog** in `claude-terminal/CHANGELOG.md`
   - Add new version section at the TOP of the file
   - Use the format: `## X.X.X` followed by `### Category - Description`
   - Categories: ✨ New Feature, 🐛 Bug Fix, 🛠️ Improvement, 📚 Documentation, 🔧 Technical
   - Include bullet points describing what changed and why

**Example workflow:**
```bash
# 1. Make your code changes
# 2. Bump version in config.yaml (e.g., 1.7.3 → 1.7.4)
# 3. Add changelog entry at the top of CHANGELOG.md
# 4. Commit all changes together
```

**Changelog entry format:**
```markdown
## 1.7.4

### ✨ New Feature - Short Description
- **Bold summary**: Detailed explanation of the change
  - Sub-bullet for additional details
  - Another sub-bullet if needed
```

**DO NOT** commit changes without updating both the version and changelog!

### Release Process (v1.3.0+)

The add-on uses **pre-built Docker images** published to GitHub Container Registry (ghcr.io) with a **two-stage CI/CD workflow**:

#### Development Workflow

1. **Make changes** to the codebase
2. **Update version** in `claude-terminal/config.yaml`
3. **Update changelog** in `claude-terminal/CHANGELOG.md`
4. **Commit and push** to main branch
   ```bash
   git add .
   git commit -m "feat: description of changes"
   git push origin main
   ```

5. **Test workflow runs automatically**
   - Triggered by push to main or pull requests
   - Builds all architectures (amd64, aarch64) using `--test` flag
   - Validates build succeeds without publishing images
   - See `.github/workflows/test.yml`

#### Publishing a Release

**When ready to publish a new version:**

1. **Create a GitHub Release**
   ```bash
   # Via GitHub CLI
   gh release create v1.3.1 \
     --title "v1.3.1" \
     --notes "$(cat <<EOF
   ## Changes
   - Feature: Description
   - Fix: Description

   See CHANGELOG.md for full details.
   EOF
   )"

   # Or via GitHub web UI:
   # - Go to Releases → Draft a new release
   # - Choose tag: v1.3.1 (create new tag)
   # - Title: v1.3.1
   # - Description: Copy from CHANGELOG.md
   # - Click "Publish release"
   ```

2. **Publish workflow runs automatically**
   - Triggered by GitHub release publication
   - Builds all architectures with Home Assistant Builder
   - **Signs images with cosign** for cryptographic verification
   - Publishes to `ghcr.io/owine/claude-terminal-prowine-{arch}`
   - Tags images with version (e.g., `1.3.1`) and `latest`
   - See `.github/workflows/publish.yml`

3. **Verify publication**
   ```bash
   # Check workflow status
   gh run list --workflow=publish.yml --limit 3

   # Verify images published
   gh api /user/packages/container/claude-terminal-prowine-amd64/versions \
     --jq '.[0] | {tags: .metadata.container.tags, created: .created_at}'
   ```

#### CI/CD Workflows

**Test Workflow** (`.github/workflows/test.yml`)
- **Triggers:** Push to any branch, pull requests
- **Purpose:** Validate builds without publishing
- **Builder flags:** `--test --all`
- **Duration:** ~2 minutes
- **Output:** Build validation only (no registry push)

**Publish Workflow** (`.github/workflows/publish.yml`)
- **Triggers:** GitHub release published
- **Purpose:** Build and publish signed production images
- **Builder flags:** `--all --cosign`
- **Duration:** ~2-3 minutes
- **Output:** Multi-arch images at ghcr.io with cosign signatures
- **Permissions:** Requires `id-token: write` for cosign

#### Image Locations

**Published images:**
- `ghcr.io/owine/claude-terminal-prowine-amd64:latest`
- `ghcr.io/owine/claude-terminal-prowine-amd64:1.3.1`
- `ghcr.io/owine/claude-terminal-prowine-aarch64:latest`
- `ghcr.io/owine/claude-terminal-prowine-aarch64:1.3.1`

**Image configuration:**
- Defined in `claude-terminal/build.yaml`
- `image:` field points to ghcr.io location
- Home Assistant pulls these pre-built images (no local build)

#### Why Pre-Built Images?

Prior to v1.3.0, Home Assistant built images locally during installation. This approach had critical flaws:

**Problems with local builds:**
- ✗ Home Assistant's npm install ignored `package-lock.json`
- ✗ Ignored exact version pins in `package.json`
- ✗ Random build failures from Docker layer caching
- ✗ 5+ minute installation time
- ✗ Inconsistent dependency versions across installs

**Benefits of pre-built images (v1.3.0+):**
- ✓ Fast installation (~30 seconds download vs ~5 minutes build)
- ✓ Guaranteed correct dependency versions (built in controlled environment)
- ✓ Cryptographically signed with cosign for supply chain security
- ✓ Standard practice for production Home Assistant add-ons
- ✓ Test builds validate changes before publication

#### Troubleshooting Releases

**Build fails in test workflow:**
- Check GitHub Actions logs: `gh run view <run-id> --log-failed`
- Common issues: Dockerfile syntax, missing files, npm dependency errors
- Fix issues and push again (test workflow re-runs automatically)

**Build fails in publish workflow:**
- Verify GitHub release was created correctly
- Check cosign permissions (`id-token: write` required)
- Ensure `--image` parameter matches `build.yaml` configuration
- Review builder logs for specific error messages

**Images not appearing in ghcr.io:**
- Check workflow completed successfully
- Verify GITHUB_TOKEN has `packages: write` permission
- Check package visibility settings (should be public)
- Allow a few minutes for registry propagation

**Home Assistant can't pull images:**
- Verify images exist: `gh api /user/packages/container/claude-terminal-prowine-amd64/versions`
- Check package is public (not private)
- Ensure `build.yaml` image field matches published location
- Try manual pull: `docker pull ghcr.io/owine/claude-terminal-prowine-amd64:latest`

## Image Service & Dependency Management

### CRITICAL: package-lock.json Requirement

The **image-service** directory contains a Node.js Express server that handles image uploads and WebSocket proxying. This service has specific npm dependencies that MUST be locked for deterministic builds.

**Why package-lock.json is critical:**
- Without it, `npm install` in Docker builds can install different versions than expected
- Docker layer caching can cause old dependency versions to be used
- This led to issues in v1.2.0-1.2.2 where security updates and WebSocket fixes didn't deploy

**Current locked dependencies (v1.2.3):**
```json
{
  "express": "5.2.1",           // Security improvements, stricter validation
  "multer": "2.0.2",            // Fixes 4 critical CVEs
  "http-proxy-middleware": "3.0.5"  // Eliminates util._extend deprecation
}
```

### When Updating Dependencies

**If you modify `image-service/package.json`:**

1. **Regenerate the lockfile:**
   ```bash
   cd claude-terminal/image-service
   npm install
   ```

2. **Commit the lockfile:**
   ```bash
   git add package-lock.json
   git commit -m "chore: update npm dependencies"
   ```

3. **Rebuild without cache:**
   ```bash
   # For Home Assistant deployment, this happens automatically on reinstall
   # For local testing (replace {arch} with amd64 or aarch64):
   docker build --no-cache \
     --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23 \
     -t local/claude-terminal:test ./claude-terminal
   ```

**IMPORTANT:** The `.gitignore` file has a specific exception for this lockfile:
```gitignore
# Blanket ignore for lockfiles
package-lock.json

# Exception: image-service lockfile needed for Docker builds
!claude-terminal/image-service/package-lock.json
```

### Dependency Update Automation

The repository uses **Renovate** for automated dependency updates:
- Auto-merges patch updates (x.x.X)
- Groups minor updates (x.X.0) for review
- Individual PRs for major updates (X.0.0)
- Security vulnerability alerts enabled
- Tracks npm, Docker, and GitHub Actions dependencies

See `renovate.json` for configuration details.

**DO NOT** commit changes without updating both the version and changelog!

## Persistent Package Management (v1.4.0+)

### CRITICAL: When Users Ask to Install Packages

**ALWAYS use `persist-install` instead of `apk add` or `pip install` directly!**

When a user asks you to install ANY package (Python, system tools, libraries, etc.), you MUST:

1. **Recognize the intent**: User says "install X", "I need X", "can you add X", etc.
2. **Use persist-install**: NEVER use `apk add` or `pip install` directly
3. **Explain why**: Tell them it will persist across reboots
4. **Verify**: Check that it worked and is available

### Why persist-install?

```bash
# ❌ WRONG - This disappears after reboot!
apk add python3

# ✅ CORRECT - This survives reboots!
persist-install python3
```

**Container Architecture**:
- `apk add` installs to ephemeral container layer (LOST on restart)
- `persist-install` installs to `/data/packages` (PERSISTENT storage)
- `/data` is mounted from Home Assistant and survives all reboots

### Usage Examples

```bash
# Install system packages (Alpine APK)
persist-install python3 py3-pip git vim htop

# Install Python packages
persist-install --python requests pandas numpy

# Install Home Assistant CLI (official ha command)
persist-install --ha-cli

# List installed packages
persist-install --list

# Check help
persist-install --help
```

### How It Works

```
/data/packages/
├── bin/              # Executable binaries (automatically in PATH)
├── lib/              # Shared libraries (LD_LIBRARY_PATH)
└── python/
    └── venv/         # Python virtual environment
        ├── bin/      # Python executables (in PATH)
        └── lib/      # Python packages (site-packages)
```

**Environment Setup**:
- `PATH="/data/packages/bin:/data/packages/python/venv/bin:$PATH"`
- Persistent packages are checked FIRST (highest priority)
- Python venv automatically activated when packages installed

### When User Asks to Install Something

**Example Conversation Flow**:

```
User: "I need Python installed"

Claude (YOU): "I'll install Python using persist-install so it survives reboots."

[Run]: persist-install python3 py3-pip

[Verify]: python3 --version

Claude: "Python 3.11.x installed successfully! It's stored in /data/packages
        and will persist across container restarts and reboots."
```

**Another Example**:

```
User: "I want to interact with Home Assistant entities"

Claude (YOU): "I'll show you how to use the Supervisor API to interact with
              Home Assistant. Let me install Python requests library."

[Run]: persist-install --python requests

[Show]: curl -H "Authorization: Bearer $SUPERVISOR_TOKEN" \
             http://supervisor/core/api/states | jq '.[0]'

Claude: "You can interact with Home Assistant using the Supervisor API!
        Check /opt/scripts/ha-api-examples.sh for more examples, or use
        Python's requests library for programmatic access."
```

### Proactive Behavior

**You should proactively use persist-install when:**

1. User mentions needing a package/tool/library
2. User wants to run a command that isn't installed
3. You recommend installing something
4. User asks about package management
5. Error indicates missing package

**Examples of user intent**:
- "install python"
- "I need git"
- "can you add vim?"
- "let's install requests"
- "how do I get pandas?"
- "bash: python: command not found" (error message)

### Common Packages Users Might Request

**System Tools**:
- `git` - Version control
- `vim` / `nano` - Text editors (nano already installed)
- `htop` - Process monitor
- `curl` / `wget` - Download tools (curl already installed)
- `jq` - JSON processor (already installed)
- `sqlite` - SQLite database

**Python Tools**:
- `python3 py3-pip` - Python and package manager
- `requests` - HTTP library for API calls
- `pyyaml` - YAML parser
- `pandas` - Data analysis
- `numpy` - Numerical computing
- `flask` / `fastapi` - Web frameworks
- `jupyter` - Jupyter notebooks

**Home Assistant CLI**:
- `ha` - Official Home Assistant CLI (install with `persist-install --ha-cli`)
  - Downloads from: https://github.com/home-assistant/cli
  - Provides commands: `ha core`, `ha supervisor`, `ha addons`, etc.
  - Alternative: Use Supervisor REST API (`http://supervisor/`) with `$SUPERVISOR_TOKEN`
  - See `scripts/ha-api-examples.sh` for API usage examples

### Auto-Install Configuration

Users can configure packages to auto-install on startup by editing the add-on configuration:

```yaml
persistent_apk_packages:
  - python3
  - py3-pip
  - git
  - vim

persistent_pip_packages:
  - homeassistant-cli
  - requests
```

**When users ask about auto-install**, guide them to:
1. Go to Settings → Add-ons → Claude Terminal
2. Click Configuration tab
3. Add packages to the lists above
4. Save and restart the add-on

### Troubleshooting

**Package not found after installation**:
```bash
# Check if it's in persistent storage
ls -la /data/packages/bin/

# Verify PATH includes persistent directory
echo $PATH | grep /data/packages

# If PATH is wrong, check if profile script exists
cat /etc/profile.d/persistent-packages.sh

# Source the profile manually if needed (temporary fix)
source /etc/profile.d/persistent-packages.sh

# If the profile script is missing, you're running an old version
# Update to v1.5.2+ which includes the PATH fix
```

**CRITICAL FIX (v1.5.2)**: Previous versions had a bug where persistent packages
were installed correctly but not in the PATH for ttyd bash sessions. This was
fixed by creating `/etc/profile.d/persistent-packages.sh` which is automatically
sourced by all bash sessions. If you installed packages before v1.5.2 and they
don't work, update to the latest version and restart the add-on.

**Python import errors**:
```bash
# Activate venv manually if needed
source /data/packages/python/venv/bin/activate

# Check installed packages
pip list
```

**Check disk usage**:
```bash
# See how much space packages use
du -sh /data/packages
```

### IMPORTANT REMINDERS

1. **NEVER use `apk add` for user-requested packages** - Always use `persist-install`
2. **ALWAYS verify after installation** - Run `--version` or test command
3. **EXPLAIN persistence** - Tell users packages will survive reboots
4. **BE PROACTIVE** - Install packages without being explicitly asked if user needs them
5. **CHECK FIRST** - Use `which` or `command -v` to see if already installed

### Example: Complete Installation Flow

```bash
# User asks: "I want to do data analysis with Python"

# Step 1: Install Python and pip
persist-install python3 py3-pip

# Step 2: Install data science packages
persist-install --python pandas numpy matplotlib jupyter

# Step 3: Verify installations
python3 --version
pip list | grep pandas

# Step 4: Inform user
echo "All set! You can now use Python for data analysis."
echo "Packages installed: pandas, numpy, matplotlib, jupyter"
echo "These will persist across reboots."
```

### Documentation Reference

For comprehensive details, see: `claude-terminal/PERSISTENT_PACKAGES.md`