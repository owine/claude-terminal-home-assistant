# Changelog

## [2.2.4](https://github.com/owine/claude-terminal-home-assistant/compare/v2.2.3...v2.2.4) (2026-03-30)


### Dependencies

* lock file maintenance ([#97](https://github.com/owine/claude-terminal-home-assistant/issues/97)) ([e99f248](https://github.com/owine/claude-terminal-home-assistant/commit/e99f2480fcb9cc914deb63d2017c1ad95466c12d))

## 2.2.4

### 🔧 Technical - Dependency Updates
- **Update all non-major dependencies**: Routine dependency bump across npm and other tracked packages via Renovate

## 2.2.3

### 🐛 Bug Fix - iOS Scroll and Keyboard Both Working
- **Fix scrolling regression from keyboard fix**: The `pointer-events: none` approach broke scrolling because iOS assigns touch targets at `touchstart` — mid-gesture changes to `pointer-events` don't redirect touches
  - Overlay is now always active (`pointer-events: auto`) on touch devices
  - Swipes are captured and converted to terminal scroll commands (unchanged)
  - Taps focus xterm.js's hidden `.xterm-helper-textarea` directly from the `touchend` handler — iOS treats this as a user-initiated focus and opens the keyboard

### 🛠️ Improvement - Favicon
- **Add browser tab icon**: Reuses the PWA `icon-192.png` as the favicon so browser tabs show the Claude HA icon instead of a generic globe

## 2.2.2

### 🐛 Bug Fix - iOS Keyboard Not Opening
- **Fix keyboard not appearing on tap**: The touch overlay was blocking native taps from reaching the iframe, preventing iOS from opening the virtual keyboard
  - Overlay now defaults to `pointer-events: none` so taps pass through natively to the iframe
  - Document-level capture listeners detect vertical swipes and only enable the overlay mid-gesture
  - Overlay returns to transparent on touchend so the next tap reaches the iframe
  - iOS requires a real (not synthetic) user tap on an input element to open the keyboard — this approach preserves that

## 2.2.1

### 🐛 Bug Fix - iOS Keyboard Hides Terminal Bottom
- **Fix terminal resizing when iOS keyboard opens**: On iOS, the virtual keyboard doesn't shrink the layout viewport (`100vh` stays full screen), causing the bottom of the terminal to be hidden behind the keyboard
  - Uses the Visual Viewport API to track the actual visible height and sets a `--app-height` CSS custom property
  - Body and container heights dynamically adjust when the keyboard opens/closes
  - Falls back to `100vh` on browsers without Visual Viewport API support

## 2.2.0

### 🔧 Technical - Migrate to New HA Builder Composable Actions
- **Replace deprecated `home-assistant/builder` action**: Migrate from monolithic builder (v2026.02.1) to composable actions (v2026.03.2)
  - `prepare-multi-arch-matrix` — generates build matrix with native runner selection
  - `build-image` — per-architecture builds with Docker Buildx, cosign signing, and caching
  - `publish-multi-arch-manifest` — combines per-arch images into unified multi-arch manifest
- **Native ARM builds**: aarch64 now builds on `ubuntu-24.04-arm` runners instead of QEMU emulation
- **Multi-arch manifest**: New `ghcr.io/owine/claude-terminal-prowine` manifest image alongside per-arch images
- **Image naming convention change**: Images now use arch-prefix format (`{arch}-claude-terminal-prowine`) matching HA ecosystem convention
- **SHA-pinned composable actions**: All builder sub-actions pinned to `62a1597b` (v2026.03.2)

## 2.1.4

### 🔧 Technical - Dependency Updates
- **Update all non-major dependencies**: Bumped npm and other non-major dependencies to latest versions for security and compatibility improvements

## 2.1.3

### 🐛 Bug Fix - iOS Touch Scrolling via Overlay
- **Fix terminal scrolling on iOS**: Touch events don't reach iframes on iOS, so previous JS handler on the container never fired
  - Added transparent touch overlay (`#touch-scroll-overlay`) positioned above the terminal iframe
  - Overlay only appears on touch devices via `@media (pointer: coarse)`
  - Vertical swipes are converted to both `WheelEvent` dispatches (for tmux mouse mode) and `scrollLines()` calls (for xterm.js buffer)
  - Single taps pass through to the iframe for normal terminal interaction
  - Horizontal swipes are ignored (not captured)
- **Viewport meta update**: Added `interactive-widget=resizes-content` for better iOS virtual keyboard behavior

## 2.1.2

### 🐛 Bug Fix - iOS Terminal Scroll (Touch-to-Wheel Forwarding)
- **Fix terminal output scrolling on iOS**: Previous CSS-only fix caused rubber-band bounce instead of scrolling terminal output
  - Added JavaScript touch-to-scroll handler that captures touch events on the terminal container
  - Converts touch swipe gestures into synthetic `WheelEvent`s dispatched on xterm.js's viewport inside the iframe
  - Reverted `overflow: auto` on terminal container back to `overflow: hidden` to prevent rubber-band effect
  - Works with both tmux mouse mode on (scrolls history) and off (scrolls xterm.js buffer)

## 2.1.1

### 🐛 Bug Fix - iOS Terminal Scrolling in PWA Mode
- **Fix touch scrolling on iOS**: Terminal was unresponsive to swipe/scroll gestures when running as a PWA on iOS
  - Added `touch-action: manipulation` to prevent iOS from capturing touch events for double-tap-zoom
  - Added `overscroll-behavior: none` to prevent viewport bounce from swallowing touch events
  - Enabled `-webkit-overflow-scrolling: touch` on the terminal container for momentum scrolling
  - Set `touch-action: auto` on the terminal iframe so it handles its own touch events
  - Disabled pinch-to-zoom via viewport meta to prevent conflicts with terminal touch handling

## 2.1.0

### ✨ New Feature - Progressive Web App (PWA) Support
- **Install to home screen**: Users can now install Claude Terminal as a standalone app on iOS and Android devices
  - App appears with a Claude `{ }` icon featuring a Home Assistant badge
  - Launches in standalone mode (no browser chrome) for a native app experience
  - Works across all access methods: direct port, HA ingress, and reverse proxies
- **Offline fallback**: When network is unavailable, a branded offline page is shown with a retry button instead of a browser error
- **OS theme integration**: Status bar and theme color adapt to the device's light/dark mode preference
- **iOS support**: Includes Apple-specific meta tags for standalone mode and status bar styling on iOS < 16.4
- **Known limitation**: PWA installed via HA ingress may need re-adding if the ingress token rotates. For the most reliable experience, install via a stable URL (direct IP or reverse proxy)

## 2.0.0

### ✨ New Feature - Mouse Mode Toggle
- **Runtime mouse mode toggle**: Added a toggle button in the header bar to switch between scroll mode and text selection mode without restarting the container
  - **Select mode** (default): Normal browser text selection works — highlight and copy as usual
  - **Scroll mode**: Mouse wheel scrolls through terminal history (50k line buffer)
  - Click the mouse button in the header to switch instantly
- **Server-side toggle API**: New `/mouse-mode` endpoints in the wrapper service execute `tmux set -g mouse` directly, so toggling doesn't disrupt the running terminal session
- **Keyboard shortcut**: Added `Prefix + m` (Ctrl+B, m) tmux key binding as an alternative to the UI button
- **Startup default preserved**: The `tmux_mouse_mode` config option still controls which mode is active on container start

### 🔧 Technical - Rename image-service to wrapper
- **Renamed `image-service/` directory to `wrapper/`**: The service now handles UI, terminal proxy, image uploads, and mouse mode toggle — not just images
  - Renamed `IMAGE_SERVICE_PORT` env var to `WRAPPER_PORT`
  - Updated Dockerfile, run.sh, .gitignore, package.json, and all documentation references
  - No user-facing changes — the service works identically

### 🛠️ Improvement - Health Check Reorder
- **Moved health check after environment init**: The Claude CLI check no longer reports a false failure on startup because PATH is now configured before the check runs

### 🐛 Bug Fix - Shellcheck Cleanup
- **Fixed all shellcheck warnings**: Resolved warnings across run.sh, claude-auth-helper.sh, claude-session-picker.sh, ha-api-examples.sh, and persistent-packages.sh

### 🔧 Technical - Dependency Updates
- **ha-mcp v6.7.2 → v7.0.0**: Major upgrade with new tools (`ha_check_update_notes`), persistent notifications in `ha_get_overview`, bundled HA skills as MCP resources, and SSRF/XSS security fix in OAuth
- **pyjwt 2.11.0 → 2.12.1**: Fix CVE-2026-32597 (RFC 7515 `crit` header validation)
- **Pin aquasecurity/trivy-action**: SHA256 digest pinning for supply chain security
- **Update GitHub Actions digests**: claude-code-action, uv, cli/cli, actions/download-artifact
- **uv 0.10.9 → 0.10.10**: Patch update for Python package manager

## 1.8.2

### 🐛 Bug Fix - Alpine CVE Patch
- **Patch Alpine base image packages**: Added `apk upgrade --no-cache` to Dockerfile to pick up security patches (zlib CVE-2026-22184) without waiting for base image releases
- **Trivy ignore-unfixed**: Only block CI on CVEs that have available fixes, avoiding false failures from upstream issues with no patch
- **Trivy ignore Windows-only CVE**: Suppress CVE-2025-15558 (docker/cli Windows privilege escalation) which is not exploitable in Alpine Linux containers

## 1.8.1

### 🔧 Technical - Security Scanning CI/CD
- **Trivy filesystem scanning**: Scans for CVEs in dependencies, leaked secrets, and Dockerfile misconfigurations on every PR and push
  - Blocks on CRITICAL and HIGH severity findings
  - Weekly scheduled scan (Mondays) catches newly disclosed CVEs
- **Trivy image scanning**: Scans published container images for OS-level vulnerabilities before release announcement
  - Runs as post-build gate in publish workflow
  - Scans Alpine base image and all installed packages

### 🐛 Bug Fix - Security Hardening
- **Path traversal prevention**: Validate uploaded image file paths stay within the upload directory, rejecting directory escape attempts
- **SHA-pin HA Builder action**: Pin `home-assistant/builder` to commit SHA for supply chain security, matching all other GitHub Actions
- **WebSocket example**: Use `wss://` protocol in API examples documentation

## 1.8.0

### ✨ New Feature - Mobile Terminal Controls
- **Control buttons**: Added ^C, Tab, Esc, arrow keys, and Enter buttons to the header bar for mobile/touch devices that lack physical keyboards
- **Paste input bar**: Text input field in the header for typing or pasting text directly into the terminal, with mobile-optimized `enterkeyhint="send"`
- **Direct iframe terminal access**: Uses ttyd's xterm.js `term` instance via same-origin iframe access for reliable input injection — no parallel WebSocket needed
- **Auto-inject image paths**: Uploaded image file paths are now sent directly to the terminal instead of relying on clipboard copy/paste
- **Voice Send to Terminal**: Voice transcripts can be sent directly to the terminal via a new "Send to Terminal" button in the voice modal
- **Responsive layout**: Header uses flex-wrap to adapt from single row (desktop) to multi-row (mobile)
- **Terminal ready indicator**: Green/red dot shows whether the terminal's xterm.js instance is accessible

## 1.7.9

### 🔧 Technical - Code Quality & Dependency Updates
- **Resolve shellcheck warnings across shell scripts**: Fixed 18 shellcheck warnings (SC2155, SC2124) across claude-session-picker.sh, health-check.sh, install-ha-cli.sh, and persistent-packages.sh
- **Lock file maintenance**: Updated @types/node 25.3.3 → 25.3.5, refreshed uv.lock for ha-mcp dependencies

### Reverted - Mobile Terminal Controls (moved to feature branch)
- Mobile terminal controls (v1.8.0-1.8.3) reverted from main due to ttyd WebSocket protocol incompatibilities requiring further development
- All work preserved on `feature/mobile-terminal-controls` branch

## 1.7.8

### 🐛 Bug Fix - Fix ha-mcp failing on Home Assistant OS (musl/Alpine Linux)
- **Pre-install ha-mcp at build time with locked dependencies**: The `ha-mcp` MCP server failed to start on Home Assistant OS because `uv`'s default `first-index` resolution strategy found `pydantic` on the HA musllinux wheel index (which lacks v2.12.5) and refused to fall through to PyPI.
  - Root cause: HA base image sets `UV_EXTRA_INDEX_URL` for the musllinux wheel index. When `uv` found `pydantic` there (wrong version), its `first-index` strategy blocked checking PyPI
  - Added `claude-terminal/ha-mcp/pyproject.toml` with pinned `ha-mcp==6.7.2` and `index-strategy = "unsafe-best-match"`
  - Added `claude-terminal/ha-mcp/uv.lock` pinning all 75 transitive dependencies with exact versions and SHA256 hashes
  - Dockerfile now runs `uv sync --locked` at build time, eliminating runtime dependency resolution entirely
  - `setup-ha-mcp.sh` now references the pre-installed binary (`/opt/ha-mcp/.venv/bin/ha-mcp`) instead of `uvx ha-mcp@latest`
  - Container startup is faster (no Python 3.14 download + 71 package resolution on every fresh start)
  - Renovate will automatically track ha-mcp and all transitive dependency updates via the `uv` manager
  - Pre-configured `ENABLE_SKILLS=true` and `ENABLE_SKILLS_AS_TOOLS=true` env vars for upcoming bundled HA best-practice skills (no-op until next ha-mcp stable release ships the feature)

## 1.7.7

### 🔧 Technical - Dependency Updates
- **Update claude-code to v2.1.50**: Keep Claude Code CLI dependency current
- **Update anthropics/claude-code-action**: Two digest bumps for the Claude Code GitHub Actions integration
- **Update astral-sh/uv to v0.10.7**: Keep uv Python package manager current
- **Lock file maintenance**: Refresh npm/pip lock files for reproducible builds
- **Set Renovate timezone to America/Chicago**: Align automated dependency update scheduling to local timezone

## 1.7.6

### 🛠️ Improvement - Docker layer caching for CI test builds
- **Add registry login to test workflow for layer cache reuse**: The test workflow now authenticates with ghcr.io (`packages: read`) so the HA builder can pull `latest` images as `--cache-from` sources. This reuses unchanged Docker layers (apk packages, npm ci, CLI downloads) for ~30-60% faster builds on PRs that only change scripts or config.
  - Added `docker/login-action` step with SHA-pinned digest
  - Added `permissions.packages: read` for least-privilege access
  - Restricted `push` trigger to `main` branch only to avoid duplicate runs on PRs
  - Updated CLAUDE.md CI documentation to describe caching behavior

## 1.7.5

### 🐛 Bug Fix - Package auto-install now actually works
- **Read /data/options.json directly instead of using bashio::config for lists**: `bashio::config` mangles list-type config values through shell variable assignment, making them unparseable as JSON. This caused package auto-install to silently skip even when packages were configured.
  - Read `/data/options.json` directly with `jq` — bypasses bashio entirely for list configs
  - Log messages now show package count (e.g., "Auto-installing 2 system package(s)")
  - Gracefully handles missing options file, missing keys, and invalid JSON
  - Locally tested with both populated and empty package lists

## 1.7.3

### 🐛 Bug Fix - Startup crash from package auto-install config parsing
- **Fix jq parse error crashing startup script**: The `auto_install_packages()` function piped `bashio::config` output directly to `jq` without validating it was valid JSON. Combined with `set -e` and `set -o pipefail`, a jq parse error (`Invalid numeric literal at line 2, column 0`) would terminate the entire startup script — not just skip the package auto-install step.
  - Add JSON validation gate before parsing config arrays
  - Add `|| true` pipeline safety to prevent `set -o pipefail` from propagating jq failures
  - Add `"null"` guard to config value checks (handles missing keys in options.json)
  - Remove unused second argument from `bashio::config` calls (Bashio ignores it for list types)
  - Log a clear warning instead of a cryptic jq error when config is unparseable

### 🔧 Technical - Dependency Updates
- **Dependency Updates**
  - Updated claude-code to v2.1.44
  - Updated cli/cli (GitHub CLI) to v2.87.3
  - Updated anthropics/claude-code-action digest to 35a9e02
  - Updated astral-sh/uv to v0.10.5
  - Updated home-assistant/builder action to v2026.02.1
  - Lock file maintenance for npm dependencies

## 1.7.2

### 🔧 Technical - Dependency Updates
- **Dependency Updates**
  - Updated cli/cli (GitHub CLI) to v2.87.2

## 1.7.1

### 📚 Documentation - Rename "add-on" to "app"
- **Align with Home Assistant 2026.2 nomenclature**: Updated all references from "add-on" to "app" across user-facing docs, internal docs, code comments, and dev tooling
  - User-facing: README, DOCS, CONTRIBUTING, PERSISTENT_PACKAGES, config.yaml, script messages
  - Internal: CLAUDE.md, code comments, linter configs, GitHub workflow comments, test scripts, tools/
  - Navigation paths updated: "Settings → Add-ons → Add-on Store" → "Settings → Apps → App Store"
  - Preserved as-is: API paths (`/addons/`), GitHub repo URLs, dev command names (`build-addon`), `flake.nix`, LICENSE, historical changelog entries

## 1.7.0

### 🛠️ Improvement - Harden Dangerous Mode Security
- **Add ALLOW_YOLO_MODE environment gate**: Dangerous mode now requires explicit opt-in via the `dangerously_skip_permissions` add-on configuration before it appears in the session picker menu
  - Menu option 9 is hidden entirely unless the gate is enabled
  - Input validation adjusts dynamically (1-8 vs 1-9) based on gate state
- **Strengthen warning messaging**: Expanded risk banner with Home Assistant-specific consequences (configuration deletion, credential exposure, automation modification, destructive commands)
  - Renamed menu entry to "Dangerous Mode (YOLO)" with radiation symbol for emphasis
  - Added recommendation to use isolated test environments only

### 🔧 Technical - CI Fix for Forked PRs
- **Skip Claude code review on fork PRs**: Added conditional to prevent OIDC/secrets failures when community contributors open PRs from forks

## 1.6.4

### 🔧 Technical - Dependency Updates
- **Dependency Updates**
  - Updated anthropics/claude-code-action to latest digest (68cfeea) via 6 incremental updates
  - Updated astral-sh/uv to v0.10.2
  - Lock file maintenance for npm dependencies

### 📚 Documentation - Accuracy Fixes
- **CLAUDE.md maintenance**
  - Removed stale version reference from documentation
  - Fixed inaccuracies in v1.6.3 changelog entry

## 1.6.3

### 🐛 Bug Fix - CI Configuration
- **Fix auto-release workflow prompt parameter** (auto-release.yml)
  - Changed incorrect `direct_prompt` input to correct `prompt` input for claude-code-action
  - Resolves workflow completing without actually running Claude

### 🔧 Technical - CI & Dependency Updates
- **Add automated weekly release workflow** (auto-release.yml)
  - Automates version bumping, changelog updates, and GitHub release creation
  - Runs every Monday at 10:00 UTC or manually via workflow dispatch
  - Analyzes commits since last tag to determine appropriate version bump (major/minor/patch)
- **Dependency Updates**
  - Updated astral-sh/uv to v0.10.1
  - Updated anthropics/claude-code-action to latest digests (b433f16, 6c61301)

## 1.6.2

### 🐛 Bug Fix - Security Hardening (Critical & High Severity)
- **Fix command injection via `eval` in session picker** (claude-session-picker.sh)
  - Replaced `eval "$CLAUDE_BIN $custom_args $base_flags"` with direct execution
  - Prevents shell metacharacter injection (`;`, `|`, `$()`, `&&`) in custom command input
  - Word splitting for user-provided flags still works correctly without `eval`
- **Add rate limiting to image upload service** (server.js)
  - General API endpoints: 60 requests/minute per IP
  - Upload endpoint: 10 uploads/minute per IP (stricter)
  - Uses in-memory sliding-window rate limiter (no new dependencies)
  - Returns HTTP 429 when rate limit exceeded
  - Periodic cleanup prevents memory leaks from abandoned IPs
- **Add CSRF protection on upload endpoint** (server.js)
  - Validates `Origin`/`Referer` header on POST requests against `Host` header
  - Blocks cross-origin attacks from malicious websites targeting local HA instances
  - Allows same-origin, CLI tools (no Origin header), and HA ingress requests
- **Remove internal path disclosure from API responses** (server.js)
  - `/health` endpoint no longer exposes `uploadDir` filesystem path
  - `/config` endpoint no longer exposes `uploadDir` filesystem path
- **Remove plaintext auth code temp file** (claude-auth-helper.sh)
  - Removed unnecessary write of auth code to world-readable `/tmp/claude-auth-code`
  - Auth code is now piped directly to Claude without touching disk
  - File-based auth reads and deletes credential file immediately to minimize exposure

## 1.6.1

### 🛠️ Improvement - Enhanced Image Upload User Experience
- **Clearer paste instructions after image upload** (index.html)
  - Changed ambiguous "Ready to use!" message to explicit "Copied! Click terminal and press Cmd+V (Mac) or Ctrl+V (Windows) to paste"
  - Added platform-specific keyboard shortcuts for better clarity
  - Updated all copy-related status messages to consistently show paste instructions
- **Visual feedback for paste location** (index.html)
  - Added blue border pulse animation (3 pulses) to highlight terminal after upload
  - Terminal highlight also triggers when clicking status to re-copy path
  - Draws user attention to where they need to paste the image path
- **Improved status message on click** (index.html)
  - Changed "click to select" to "click here to copy again" for clarity
  - Re-copying triggers paste instructions and terminal highlight
  - Consistent messaging across all copy/paste interactions

**Background:** The auto-paste functionality fails due to browser security (cross-origin iframe restrictions), which is expected and cannot be bypassed. These UX improvements make it crystal clear that manual paste is required and guide users through the correct workflow.

**Use Case:** Users upload an image, path is copied to clipboard, terminal pulses blue, status shows clear instructions with keyboard shortcuts, user clicks terminal and pastes. Previously, users were confused by "Ready to use!" message and didn't realize they needed to manually paste.

### 🐛 Bug Fix - CI Workflow Improvements
- **Skip claude-review workflow on GitHub Actions updates** (.github/workflows/claude-code-review.yml)
  - Prevents claude-review from blocking automerge on GHA workflow updates
  - The code-review plugin consistently errors when analyzing YAML workflows
  - Allows GitHub Actions dependency updates to auto-merge while still reviewing code changes
  - Fixes CI failures that were blocking Renovate's automerge feature

### 🔧 Technical - Dependency Management & Updates
- **Configure Renovate for stable Claude Code channel with automerge** (renovate.json)
  - Switch Claude Code datasource from 'latest' to 'stable' channel
  - Add automerge rule for Claude Code patch updates only
  - Ensures bug fixes auto-merge while features/breaking changes need review
  - Improves dependency update reliability and reduces maintenance burden
- **Updated Claude Code CLI to v2.1.33** (Dockerfile)
  - Patch version update from v2.1.32
  - Includes bug fixes and stability improvements
  - Automatic SHA256 integrity verification during build
- **Updated astral-sh/uv to v0.10.0** (.github/workflows/)
  - Python package manager used in development workflow
  - Renovate PR #31
- **Updated claude-code-action to digest b113f49** (.github/workflows/)
  - GitHub Action for automated code reviews
  - Internal improvements and bug fixes
  - Renovate PR #29

## 1.6.0

### ✨ New Feature - YOLO Mode for Unrestricted Sessions
- **Menu option 9: Launch Claude with `--dangerously-skip-permissions`** (claude-session-picker.sh) - *contributed by @alexcf*
  - Provides unrestricted file access and command execution for power users
  - Requires typing "YOLO" to confirm understanding of security risks
  - Visual separator in menu distinguishes dangerous option from standard modes
  - Comprehensive warning screen explains all risks before proceeding
  - Sub-menu for session type selection (New/Continue/Resume)
  - Command-scoped `IS_SANDBOX=1` prevents environment pollution
  - Pre-flight validation ensures Claude binary exists before showing prompts
  - Error handling with actionable messages for exit codes 1-128
  - Logs all operations to stderr for debugging and monitoring
  - Returns to menu after session ends (consistent with other options)

**Use Case:** Advanced users who trust Claude completely and want to eliminate permission prompts for faster workflows. Similar to `sudo` in Linux - powerful but requires understanding of risks.

**Security Notes:**
- Only use YOLO mode when you fully trust the code Claude will execute
- Different from config option `dangerously_skip_permissions` (global) - this is per-session
- Uses undocumented `IS_SANDBOX=1` workaround to bypass root privilege restrictions
- Exit code handling provides visibility into session outcomes

### 🔧 Technical - Dependency Updates
- **Updated Claude Code CLI to v2.1.32** (Dockerfile)
  - Patch version update with bug fixes and improvements
  - Automatic SHA256 integrity verification during build
- **Updated claude-code-action to digest 006aaf2** (.github/workflows/)
  - Internal refactor for better action performance
  - Includes Claude Code v2.1.32 and Agent SDK v0.2.32
  - CI/CD workflow improvements

## 1.5.6

### ✨ New Feature - 'menu' Shell Alias for Easy Navigation
- **Added convenient 'menu' alias to return to session picker from bash** (run.sh, claude-session-picker.sh)
  - When users drop to bash shell (menu option 7), they can now type `menu` to return
  - Alias automatically added to `/etc/profile.d/persistent-packages.sh` during startup
  - Available in all bash login shells without additional configuration
  - Updated drop-to-bash tips to highlight the new `menu` command
  - Improves user experience: No need to remember the full path `/usr/local/bin/claude-session-picker`

**Use Case:**
Users frequently drop to bash for quick commands, then want to return to the menu to start a new Claude session. Previously required typing the full script path or restarting the add-on. Now just type `menu`.

### 📚 Documentation - Comprehensive Cleanup and Consolidation
- **Fixed incorrect installation URLs** (README.md, DOCS.md)
  - Updated all references from ESJavadex repository to owine's fork
  - Ensures users add the correct repository: `https://github.com/owine/claude-terminal-home-assistant`
- **Removed outdated version history** (README.md)
  - Replaced v1.0.x version history with reference to CHANGELOG.md
  - Prevents confusion about current version (was showing v1.0.2, actual is 1.5.6)
- **Updated dependency versions** (DOCS.md, IMAGE_PASTE.md → DOCS.md)
  - Express: v4.18.2 → v5.2.1 (security improvements)
  - Multer: v1.4.5 → v2.0.2 (fixes 4 critical CVEs)
  - Added security context to dependency descriptions
- **Enhanced DOCS.md with recent features**
  - Added session picker menu documentation with all 8 options
  - Documented `menu` alias for returning to picker from bash
  - Added tmux mouse mode configuration option
  - Expanded image paste support details (formats, storage, usage)
  - Added persistent package management overview
  - Included session management features (GitHub CLI, tmux persistence)
  - Updated configuration options table with all current settings
- **Consolidated documentation files**
  - Merged IMAGE_PASTE.md (172 lines) into DOCS.md as detailed subsection
  - Deleted `config/README.md` (40 lines) - test directory is self-explanatory
  - Deleted `tools/README.md` (36 lines) - single tool with its own documentation
  - Reduced total markdown file count: 16 → 13 files
  - Single source of truth for image paste feature documentation

**Impact**: Users now have accurate, up-to-date, and well-organized documentation that reflects the current state of the add-on with all recent features. Streamlined file structure is easier to navigate and maintain.

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
