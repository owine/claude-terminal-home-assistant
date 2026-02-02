# Changelog

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
