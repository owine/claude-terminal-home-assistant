# Changelog

## 1.0.0

### 🎉 Initial Release - Personal Fork

Personal fork maintained by [@owine](https://github.com/owine).

**Built upon work from:**
- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) - Original Claude Terminal add-on
- [ESJavadex/claude-code-ha](https://github.com/ESJavadex/claude-code-ha) - Enhanced fork with persistent packages

### Current Features

- **Native Claude Code Installation**: Uses Anthropic's official installer (`curl -fsSL https://claude.ai/install.sh`)
- **Persistent Package Management**: Install packages that survive reboots with `persist-install`
- **Image Paste Support**: Upload images via paste, drag-drop, or button click
- **Voice Input**: Speech-to-text using Web Speech API
- **GitHub CLI**: Pre-installed `gh` with persistent authentication
- **Session Picker**: Interactive menu for session management
- **Full Home Assistant API Access**: Supervisor, Core, and WebSocket APIs

### Technical Details

- Alpine Linux base with ttyd web terminal
- Multi-architecture support: amd64, aarch64, armv7
- Persistent storage in `/data` for credentials, packages, and images
- Native Claude binary installed to `~/.local/bin`

---

## Previous Version History (Fork)

<details>
<summary>Click to expand changelog from forked repositories</summary>

### 2.0.6 (ESJavadex fork)

#### 🛠️ Improvement - Native Claude Code Installation
- **Migrated to native installer**: Claude Code now installed using Anthropic's recommended native binary installer
  - Replaces npm installation (`@anthropic-ai/claude-code`) with `curl -fsSL https://claude.ai/install.sh | bash`
  - More reliable builds (no npm retry logic needed)
  - Follows Anthropic's official distribution method
  - npm installation is deprecated by Anthropic
- **Updated health checks**: Network connectivity now validates `claude.ai` instead of npm registry
- **Simplified run.sh**: Removed `node $(which claude)` wrapper, now calls `claude` directly

#### 🐛 Bug Fix - Claude Code Native Installation PATH
- **Fixed "~/.local/bin is not in your PATH" warning**: Added `$HOME/.local/bin` to PATH
  - Claude Code CLI may install native components to `~/.local/bin`
  - Container HOME is `/data/home`, so this resolves to `/data/home/.local/bin`
  - Directory is now created on startup and included in PATH
  - Fix applies to both init_environment and profile script for all bash sessions

### 2.0.5

#### 🐛 Bug Fix - Claude CLI Not Found
- **Fixed session picker failing to launch Claude**: Used full path `/usr/local/bin/claude`
  - ttyd bash sessions don't inherit full PATH from parent process
  - All claude invocations now use absolute path for reliability

### 2.0.4

#### ✨ New Feature - GitHub CLI Pre-installed
- **GitHub CLI (gh) included**: GitHub's official CLI tool now pre-installed in Docker image
  - Create, view, and manage GitHub issues and pull requests
  - Work with GitHub repositories directly from the terminal
  - Authenticate with `gh auth login`
  - Essential for git workflows: `gh pr create`, `gh issue list`, `gh repo clone`
  - Automatically fetches latest version during build

#### 🛠️ Improvement - Persistent GitHub Authentication
- **GitHub credentials survive reboots**: `GH_CONFIG_DIR` set to `/data/.config/gh`
  - Login once with `gh auth login`, credentials persist across container restarts
  - Consistent with Claude credential persistence approach
  - No need to re-authenticate after Home Assistant updates
- **Session picker menu option**: New "🐙 GitHub CLI login" option (choice 6)
  - Guided authentication flow with browser or token options
  - Shows current auth status before prompting
  - Instructions for creating GitHub personal access tokens

### 2.0.3

#### ✨ New Features - Enhanced Developer Toolkit
- **Pre-installed Python libraries**: Common libraries for Home Assistant scripting
  - `py3-requests` - HTTP library for API calls
  - `py3-aiohttp` - Async HTTP client/server
  - `py3-yaml` - YAML parsing for HA configuration
  - `py3-beautifulsoup4` - HTML/XML parsing
- **Additional system tools**: More utilities available out-of-the-box
  - `vim` - Advanced text editor
  - `wget` - File download utility
  - `tree` - Directory tree visualization
  - `yq` - YAML processor (essential for Home Assistant configs)

### 2.0.0 - 2.0.2

- Git pre-installed in Docker image
- Various bug fixes for CLI launch issues
- Recommended plugins documentation

### 1.0.0 - 1.7.1 (heytcass original)

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
