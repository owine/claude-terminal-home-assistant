# Changelog

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
  - Reconnect to existing sessions automatically
  - OSC 52 clipboard support for copy/paste
  - 50k line scroll history
- **Home Assistant MCP Integration**: Natural language control of Home Assistant via [ha-mcp](https://github.com/homeassistant-ai/ha-mcp)
  - 97+ tools for entity control, automations, scripts, dashboards, history
  - Automatic authentication via Supervisor API
  - Enable/disable via `enable_ha_mcp` config option
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
