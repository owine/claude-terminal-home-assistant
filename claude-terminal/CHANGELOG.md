# Changelog

## 1.5.5

### 🐛 Bug Fix - Home Assistant Config Schema Validation Error
- **Fixed invalid config.yaml schema for tmux_mouse_mode** (config.yaml)
  - Error: `does not match regular expression` for `tmux_mouse_mode` schema
  - Root cause: Nested `name`/`description` structure not supported in Home Assistant schema
  - Previous structure: Incorrectly used nested object with `name`, `description`, `type` fields
  - New structure: Simple `bool?` type definition with comment-based description
  - Impact: Add-on config now validates correctly in Home Assistant Supervisor
  - Users can now see and configure `tmux_mouse_mode` without schema warnings

**Technical Details:**
- Home Assistant's add-on schema validator doesn't support inline nested metadata
- Schema field must be a type definition regex (e.g., `bool?`, `str?`, `int(0,100)?`)
- Descriptions should be provided as comments in `options` section, not in `schema`
- This fix resolves Supervisor warnings in `/data/addons/git/*/config.yaml` validation

## 1.5.4

### 🐛 Bug Fix - Claude Binary "Leftover npm Installation" Warning
- **Eliminated false warning about npm installation** (Dockerfile, run.sh)
  - Root cause: Claude CLI detects `/usr/local/bin/claude` and assumes old npm install
  - Previous approach: Binary installed to `/root/.local/bin/` with symlink to `/usr/local/bin/`
  - The symlink triggered Claude's built-in warning about deprecated npm installations
  - New approach: Copy binary to persistent home directory on first run
  - Changes:
    - Removed symlink from Dockerfile (no more `/usr/local/bin/claude`)
    - Added copy logic in run.sh to copy `/root/.local/bin/claude` → `/data/home/.local/bin/claude`
    - Copy happens once on first run (persistent across restarts and updates)
    - Leverages existing `$HOME/.local/bin` in PATH (no PATH modifications needed)
  - Benefits:
    - ✅ Warning eliminated (no file at `/usr/local/bin/claude`)
    - ✅ Claude accessible via PATH (`which claude` works)
    - ✅ Binary persists in `/data/home` (survives updates)
    - ✅ Follows same pattern as skills installation
    - ✅ No additional PATH entries needed

### 📚 Documentation - Claude Command Examples
- **Fixed incorrect Claude command examples in DOCS.md**
  - Removed incorrect `node` prefix (Claude is a native binary, not Node.js script)
  - Before: `node /usr/local/bin/claude`
  - After: `claude`
  - Simplified all command examples to use PATH-resolved `claude`

**Technical Note:**
- Claude CLI checks standard locations (`/usr/local/bin`) for deprecated npm installations
- Modern installation uses native binaries in `~/.local/bin` (XDG Base Directory spec)
- By removing the symlink and using persistent home directory, we follow best practices

## 1.5.3

### ✨ New Feature - Configurable tmux Mouse Mode
- **Added configuration option for tmux mouse mode** (config.yaml, run.sh, tmux.conf)
  - Users can now choose between mouse mode on/off in add-on settings
  - **Default: Disabled** (mouse mode off) for easier text selection
  - When disabled: Normal browser text selection works (click and drag to copy)
  - When enabled: Mouse wheel scrolling in tmux, but requires Shift+select to copy text
  - Setting is applied dynamically at container startup
  - Configuration: Settings → Add-ons → Claude Terminal Prowine → Configuration → "Enable tmux mouse mode"

**Why this matters:**
- Previous versions had mouse mode always enabled, making text selection difficult
- Users reported text deselects immediately when trying to copy
- Now users can choose based on their preference:
  - Prefer easy text copying? Keep disabled (default)
  - Prefer mouse scrolling? Enable in settings (requires Shift+select for copying)

## 1.5.2

### 🐛 Bug Fix - WebSocket Connection Failure (Blank Terminal)
- **Fixed critical WebSocket path rewriting bug in image-service proxy** (server.js:100-121)
  - Root cause: WebSocket upgrade handler didn't strip `/terminal` prefix like HTTP requests
  - HTTP proxy worked: `/terminal/token` → `/token` (path stripped ✓)
  - WebSocket failed: `/terminal/ws` → `/terminal/ws` (path NOT stripped ✗)
  - Result: ttyd rejected connections with "illegal ws path: /terminal/ws"
  - Symptom: Blank terminal window with "Press Enter to Reconnect" message
  - Fix: Added explicit `pathRewrite: {'^/terminal': ''}` to proxy configuration
  - WebSocket upgrades now correctly strip ingress prefix before forwarding to ttyd
  - Terminal now loads and displays session picker/Claude interface correctly

### 🔧 Technical - Multi-Arch Build System Fix
- **Fixed multi-arch build configuration** (Dockerfile, build.yaml, renovate.json)
  - Removed hardcoded `BUILD_FROM` default with architecture-specific SHA256 digest
  - Before: `ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23@sha256:...` (hardcoded amd64)
  - After: `ARG BUILD_FROM` (no default, provided by builder or developer)
  - Benefits:
    - Eliminates risk of aarch64 builds using amd64 base image
    - Clear separation: `build.yaml` controls CI/CD, `--build-arg` controls local builds
    - Local Docker testing works (home-assistant base is standalone-capable)
    - Renovate tracks both architectures in `build.yaml` via custom regex manager
  - Added Renovate comments to `build.yaml` for automated version updates
  - Updated CLAUDE.md with correct local build command using `--build-arg`

## 1.5.1

### 🐛 Bug Fix - Session Picker Immediately Exits
- **Fixed critical shell quoting bug in tmux session creation** (run.sh:361)
  - Root cause: Single quotes in `bash -l -c '$launch_command'` prevented variable expansion
  - Bash received literal string `$launch_command` instead of actual command
  - Result: "command not found" → immediate session exit
  - Fix: Changed to `bash -l -c \"$launch_command\"` with escaped double quotes
  - Sessions now start correctly with the session picker menu when `auto_launch_claude: false`

## 1.5.0

### 🔒 Security - Binary Integrity Verification & Supply Chain Hardening

- **Implemented SHA256 checksum verification for all verifiable dependencies**
  - Claude Code: Verifies SHA256 from manifest.json before installation
  - uv: Downloads and verifies platform-specific .sha256 files
  - GitHub CLI: Verifies against checksums.txt from releases
  - All builds fail on checksum mismatch (prevents compromised binaries)

- **Discovered and fixed security issue in uv installer**
  - Official uv installer script does NOT verify checksums despite having verification code
  - Replaced with manual download + SHA256 verification
  - Binary integrity now guaranteed for all CLI tools

- **Enhanced supply chain security**
  - Version pinning for all dependencies tracked by Renovate
  - Automated dependency updates via Renovate PRs
  - SHA256 digest pinning for GitHub Actions
  - SHA256 digest pinning for Docker base images

**Security coverage:**
- ✅ Claude Code 2.1.29 - SHA256 verified (manifest.json)
- ✅ uv 0.9.28 - SHA256 verified (.sha256 file)
- ✅ GitHub CLI 2.86.0 - SHA256 verified (checksums.txt)
- ✅ GitHub Actions - SHA256 digest pinned
- ✅ Docker base images - SHA256 digest pinned
- ❌ Home Assistant CLI - No checksums provided by upstream

**Technical implementation:**
- Download manifest/checksum file for each dependency
- Extract platform-specific expected SHA256
- Download binary and compute actual SHA256
- Fail build if mismatch detected
- Install only verified binaries

### 🔧 CI/CD Improvements

- **Pinned GitHub Actions runner to ubuntu-24.04**
  - Replaces ubuntu-latest (moving target)
  - Ensures reproducible builds across all workflows
  - Prevents unexpected breakage from runner upgrades
  - Applies to: test, publish, claude, claude-code-review workflows

- **Enhanced Renovate dependency management**
  - Custom regex managers for Dockerfile ARG versions
  - Automatic detection of uv, gh CLI, and ha CLI versions
  - Grouped patch updates with auto-merge for CLI tools
  - Separate PRs for major updates with clear labeling
  - Fixed configuration to use correct manager syntax

**Renovate tracking:**
- 21 total dependencies monitored
- 4 custom regex dependencies (Claude Code, uv, gh CLI, ha CLI)
- Automated PR creation for all updates
- Smart grouping reduces PR noise

**Updated workflows:**
- All workflows now use ubuntu-24.04 instead of ubuntu-latest
- Digest pinning for actions (except home-assistant/builder)
- Best-practices preset with semantic commits

### 📚 Documentation

- Updated CLAUDE.md with comprehensive release process documentation
- Documented two-stage CI/CD workflow (test on push, publish on release)
- Added troubleshooting guide for pre-built images
- Clarified GitHub Container Registry usage

**Files updated:**
- Dockerfile - Added SHA256 verification for Claude Code, uv, and GitHub CLI
- renovate.json - Added custom managers and package rules for CLI tools
- .github/workflows/* - Pinned ubuntu-24.04, digest pinning
- CLAUDE.md - Enhanced release documentation

## 1.4.0

### ⚠️ Breaking Change - Remove armv7 Support

- **BREAKING: Removed armv7 (32-bit ARM) architecture support**
  - Modern Home Assistant installations primarily use 64-bit systems
  - Simplifies build and maintenance overhead
  - Reduces CI/CD build time by ~33%

**Supported architectures:**
- ✅ amd64 (x86-64)
- ✅ aarch64 (64-bit ARM)
- ❌ armv7 (32-bit ARM) - removed

**Impact:**
- Users on 32-bit ARM systems (Raspberry Pi 2, older devices) cannot use v1.4.0+
- Most modern systems (Raspberry Pi 3+, 4, 5) use aarch64 and are unaffected

**Updated files:**
- build.yaml - Removed armv7 base image
- config.yaml - Removed armv7 from arch list
- Dockerfile - Removed armv7 architecture cases
- renovate.json - Removed armv7 base image tracking
- Documentation - Updated to reflect amd64/aarch64 only

## 1.3.1

### 🔧 CI/CD Improvements - Enhanced Build Security & Testing

- **Two-stage CI/CD workflow**:
  - Test builds on pull requests (using `--test` flag, no publishing)
  - Production builds on version tags with image signing
  - Manual workflow dispatch with test-only option

- **Cosign image signing**: All published images now cryptographically signed
  - Enables verification of build chain integrity
  - Adds `id-token: write` permission for cosign
  - Follows Home Assistant Builder security best practices

- **Fixed Claude CLI PATH warning during Docker build**:
  - Set `PATH` before running installer to silence warnings
  - Warning was harmless (symlink + runtime PATH worked correctly)
  - Build output now cleaner without false-positive warnings

**Why this matters:**
- PRs are now validated with actual builds before merging
- Published images are cryptographically signed for security
- CI/CD follows Home Assistant's recommended two-stage workflow

**Technical details:**
- `test-build` job: Runs on PRs, uses `--test` flag (no registry push)
- `publish-build` job: Runs on tags, uses `--cosign` flag for signing
- Dockerfile: Sets PATH before Claude installer to prevent warnings

## 1.3.0

### 🚀 Major Change - Pre-Built Images via GitHub Container Registry

- **BREAKING: Now uses pre-built Docker images instead of local builds**
  - Images built in GitHub Actions (controlled environment)
  - Published to GitHub Container Registry (ghcr.io)
  - Fast installation (~30 seconds vs ~5 minutes)
  - Guaranteed correct dependency versions

**Why this change:**
- Home Assistant's local build system is fundamentally broken
- Ignores package-lock.json, ignores exact version pins
- Random build failures, slow builds, inconsistent results
- Pre-built images are standard practice for production HA add-ons

**What changed:**
- `build.yaml`: Now references `ghcr.io/owine/claude-terminal-prowine-{arch}`
- GitHub Actions: Builds images on version tags (v1.3.0)
- Dockerfile: Restored proper `npm ci` (runs in GHA, not HA)
- Removed bundled node_modules (no longer needed)

**User impact:**
- ✅ Much faster installation (download vs build)
- ✅ More reliable (no build failures)
- ✅ Automatic updates when new versions released
- ❌ Requires GitHub Container Registry access (free, public)

**For developers:**
- Images built automatically on `git push origin v1.3.0`
- Multi-arch support: amd64, aarch64, armv7
- Uses GitHub Actions build cache for speed

This is the **correct long-term solution** vs the v1.2.5 workaround
of bundling node_modules.

## 1.2.5

### 🔴 NUCLEAR OPTION - Bundle node_modules in Repository

- **CRITICAL: Pre-install node_modules to bypass broken HA build system**
  - Home Assistant's npm install is fundamentally broken
  - Ignores package-lock.json, ignores exact version pins
  - Installs http-proxy-middleware v2 despite explicit v3.0.5 pin
  - Even removing/re-adding repository doesn't clear cache

**What we tried (all failed):**
1. ✅ v1.2.3: Added package-lock.json - HA ignored it
2. ✅ v1.2.4: Pinned exact versions (no ^ semver) - HA ignored it
3. ✅ Changed slug to force fresh build - HA used old cache
4. ✅ Removed/re-added repository - HA still installed wrong versions

**Root Cause:**
Home Assistant's Docker build system has an aggressive npm cache or
pre-built image cache that CANNOT be bypassed by any conventional means.

**Nuclear Solution: Bundle node_modules (8.5MB)**
- Commit the entire node_modules directory with correct versions
- Skip `npm install` in Dockerfile entirely
- Guarantees correct dependencies regardless of HA build process
- Trade-off: Larger repository, but deterministic builds

**This is the final, last-resort fix.** If this doesn't work, the HA build
system is irreparably broken and would require switching to a different
deployment method entirely.

## 1.2.4

### 🔧 Critical Fix - Pin Exact Dependency Versions

- **CRITICAL: Removed semver ranges from package.json**
  - Changed `^5.2.1` → `5.2.1` (express)
  - Changed `^2.0.2` → `2.0.2` (multer)
  - Changed `^3.0.5` → `3.0.5` (http-proxy-middleware)

**Root Cause:**
- Home Assistant's build process was not using package-lock.json
- Even after removing/re-adding repository, HA installed wrong versions
- npm with semver ranges (`^3.0.5`) can resolve to different versions
- Without lockfile enforcement, npm installed http-proxy-middleware v2 instead of v3

**Impact:** v1.2.0-1.2.3 all failed to deploy correct dependencies despite:
- package-lock.json being committed (v1.2.3)
- Changing slug to force fresh build
- Completely removing and re-adding repository
- Multiple clean reinstalls

**Solution:** Pin exact versions in package.json as last resort
- Even if HA ignores package-lock.json, it MUST respect exact versions
- This guarantees correct dependency installation regardless of build environment

**This is the final fix** - exact versions ensure deterministic builds even when lockfile is ignored.

## 1.2.3

### 🔧 Build Fix - Missing Package Lockfile

- **CRITICAL: Added package-lock.json for deterministic builds**
  - Previous versions (1.2.0-1.2.2) failed to deploy updated dependencies
  - `npm install` in Docker build was resolving versions from scratch
  - Docker layer caching caused old dependency versions to be used
  - Added gitignore exception for `claude-terminal/image-service/package-lock.json`

**Root Cause:**
- `.gitignore` blanket-ignored all `package-lock.json` files
- Docker builds ran `npm install` without a lockfile
- This caused npm to install unpredictable versions or use cached layers with old dependencies (http-proxy-middleware v2 instead of v3)

**Impact:** v1.2.0-1.2.2 code changes were correct, but couldn't be deployed because:
- `util._extend` deprecation persisted (still using http-proxy-middleware v2)
- WebSocket upgrade handler existed but wasn't running (old code in container)
- Security fixes in multer v2 and express v5 weren't applied

**Fix:**
- Generated package-lock.json with correct versions (express 5.2.1, multer 2.0.2, http-proxy-middleware 3.0.5)
- Added gitignore exception to track the lockfile in version control
- **REBUILD REQUIRED:** `podman build --no-cache` to bypass Docker layer cache

This is a **critical build fix** - v1.2.0-1.2.2 will not work without rebuilding with this lockfile.

## 1.2.2

### 🔴 Critical Fix - WebSocket Upgrade Handler

- **CRITICAL: Fixed WebSocket proxying in http-proxy-middleware v3**
  - Added explicit `server.on('upgrade', terminalProxy.upgrade)` handler
  - WebSocket upgrade now properly forwarded to ttyd terminal
  - Fixes "illegal ws path: /terminal/ws" errors

**Root Cause:**
- http-proxy-middleware v3 requires explicit upgrade event handling
- The `ws: true` option alone is insufficient for WebSocket proxying
- Must call `proxy.upgrade` on the server's upgrade event

**Impact:** Without this fix, terminal WebSocket connections fail completely, preventing interactive terminal access.

**Technical Details:**
- Extracted proxy middleware to named constant for upgrade handler registration
- Server now properly handles HTTP → WebSocket protocol upgrade
- Added logging to confirm WebSocket handler is registered

This is a **critical hotfix** for v1.2.0 and v1.2.1 - WebSocket functionality was broken in both versions.

## 1.2.1

### 🐛 Bug Fix - WebSocket Error Handling

- **Fixed critical WebSocket proxy error**: TypeError when WebSocket upgrade fails
  - Error handler now properly checks if `res.status` exists before calling
  - WebSocket errors use `res.writeHead` for proper error responses
  - Prevents image service crash when WebSocket connection fails

**Technical Details:**
- http-proxy-middleware v3 has different error signatures for HTTP vs WebSocket
- WebSocket upgrade errors don't have Express's `res.status()` method
- Added defensive checks to handle both error types gracefully

This hotfix is required for v1.2.0 to work properly with WebSocket connections.

## 1.2.0

### 🛡️ Security - Critical Dependency Updates & Automation

- **Major dependency security updates**:
  - multer: 1.4.5-lts.2 → 2.0.2 (fixes 4 critical CVEs: CVE-2025-47935, CVE-2025-47944, CVE-2025-48997, CVE-2025-7338)
  - express: 4.18.2 → 5.2.1 (security improvements, CVE-2024-47764)
  - http-proxy-middleware: 2.0.6 → 3.0.5 (eliminates Node.js deprecation warnings)

- **Code modernization**:
  - Migrated http-proxy-middleware to v3 API (new event syntax, auto-stripping mount points)
  - Updated proxy configuration for compatibility with latest version
  - Eliminated `util._extend` deprecation warning

- **Automated dependency management**:
  - Added Renovate for automatic dependency updates
  - Smart auto-merge rules for patch updates
  - Security vulnerability alerts enabled
  - Tracks 25+ dependencies across npm, Docker, and GitHub Actions

- **CI/CD improvements**:
  - Fixed Claude Code Review workflow to support Renovate bot
  - GitHub Actions updated: actions/checkout v4 → v6
  - Improved automation reliability

### 🔧 Technical Details

- **Breaking dependency changes** (transparent to users):
  - Express v5: Stricter status code validation, removed `res.redirect('back')`
  - http-proxy-middleware v3: New event handler syntax, automatic path stripping
  - multer v2: Requires Node.js 10.16+ (already met by Alpine 3.23)

- **Renovate configuration**:
  - Auto-merge enabled for patch updates
  - Grouped minor updates for easy review
  - Individual PRs for major updates requiring careful review
  - Monthly lockfile maintenance

All changes are backward compatible for add-on users. Internal dependencies modernized with no breaking changes to add-on functionality.

## 1.1.0

### ✨ Feature - tmux Session Persistence & Menu Improvements

- **tmux session persistence**: Fixed using pattern from [ttyd#1396](https://github.com/tsl0922/ttyd/issues/1396)
  - tmux session created BEFORE ttyd starts (avoids nesting errors)
  - Sessions persist when navigating away from add-on
  - 50k line scroll history, mouse support, OSC 52 clipboard
- **Menu as home base**: When Claude exits, returns to menu
  - Renamed "Session Picker" to "Menu"
  - Added "Clear & restart session" option
  - "Drop to bash" exits menu permanently
- **Alpine 3.23 base image**: Updated from 3.19
  - ttyd: 1.7.4 → 1.7.7
  - libwebsockets: 4.3.2 → 4.3.5

## 1.0.1

### 🐛 Bug Fix - Revert tmux auto-session

- **Removed automatic tmux session management**: tmux was causing "sessions should be nested with care" errors when running inside ttyd's container environment
  - Session picker now launches Claude directly without tmux wrapper
  - tmux remains installed and available for manual use if desired
  - All session picker options (new, continue, resume, custom) work correctly

## 1.0.0

### 🎉 Initial Release - Personal Fork

Personal fork maintained by [@owine](https://github.com/owine).

**Built upon work from:**
- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) - Original Claude Terminal add-on by Tom Cassady
- [ESJavadex/claude-code-ha](https://github.com/ESJavadex/claude-code-ha) - Enhanced fork by Javier Santos

**Integrated PRs from upstream:**
- [PR #46](https://github.com/heytcass/home-assistant-addons/pull/46) - tmux session persistence by Petter Sandholdt
- [PR #49](https://github.com/heytcass/home-assistant-addons/pull/49) - ha-mcp Home Assistant MCP integration by Brian Egge

### Current Features

- **Native Claude Code Installation**: Uses Anthropic's official installer (`curl -fsSL https://claude.ai/install.sh`)
- **tmux Session Persistence**: Terminal sessions survive navigation away from the add-on
  - Sessions created before ttyd to avoid nesting issues
  - Reconnect to existing sessions automatically
  - Press `Ctrl+B R` to respawn if Claude exits
  - 50k line scroll history, OSC 52 clipboard support
- **Home Assistant MCP Integration**: Natural language control of Home Assistant via [ha-mcp](https://github.com/homeassistant-ai/ha-mcp)
  - 97+ tools for entity control, automations, scripts, dashboards, history
  - Automatic authentication via Supervisor API
  - Enable/disable via `enable_ha_mcp` config option
- **Persistent Package Management**: Install packages that survive reboots with `persist-install`
- **Image Paste Support**: Upload images via paste, drag-drop, or button click
- **Voice Input**: Speech-to-text using Web Speech API
- **GitHub CLI**: Pre-installed `gh` with persistent authentication
- **Interactive Menu**: Home base for session management (returns after Claude exits)
- **Full Home Assistant API Access**: Supervisor, Core, and WebSocket APIs

### Technical Details

- Alpine Linux base with ttyd web terminal
- Multi-architecture support: amd64, aarch64, armv7
- Persistent storage in `/data` for credentials, packages, and images
- Native Claude binary installed to `~/.local/bin`
- uv package manager for ha-mcp execution

---

## Previous Version History (Fork)

<details>
<summary>Click to expand changelog from forked repositories</summary>

### From ESJavadex fork (2.0.x series)

- Native Claude Code installation (replaces npm)
- GitHub CLI pre-installed with persistent authentication
- Pre-installed Python libraries and system tools
- Git pre-installed in Docker image

### From heytcass original (1.0.x - 1.7.x series)

- Web-based terminal interface using ttyd
- Pre-installed Claude Code CLI
- OAuth authentication with Anthropic account
- Session picker with multiple launch modes
- Persistent package system (`persist-install`)
- Image paste support with drag-drop
- Voice input with Web Speech API
- Full Home Assistant API access
- Multi-architecture support

</details>
