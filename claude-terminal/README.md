# Claude Terminal Prowine for Home Assistant

An enhanced, web-based terminal with Claude Code CLI and persistent package management for Home Assistant.

![Claude Terminal Screenshot](screenshot.png)

*Claude Terminal Prowine running in Home Assistant*

> **Fork Attribution:** A personal fork by [@owine](https://github.com/owine), built on [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) (original by Tom Cassady) and [ESJavadex/claude-code-ha](https://github.com/ESJavadex/claude-code-ha) (enhanced fork by Javier Santos). See the [repository README](https://github.com/owine/claude-terminal-home-assistant#fork-attribution) for full credits.

## What is Claude Terminal Prowine?

This app provides a web-based terminal interface with Claude Code CLI pre-installed plus persistent package management, allowing you to use Claude's powerful AI capabilities directly from your Home Assistant dashboard. It gives you direct access to Anthropic's Claude AI assistant through a terminal, ideal for:

- Writing and editing code
- Debugging problems
- Learning new programming concepts
- Creating Home Assistant scripts and automations

## Features

### Core Features
- **Web Terminal Interface**: Access Claude through a browser-based terminal using ttyd
- **Auto-Launch**: Claude starts automatically when you open the terminal
- **Pinned Claude Code CLI**: Pre-installed with a specific, integrity-verified version of Anthropic's official CLI (SHA256-checked, not `@latest`)
- **Zero Configuration to Start**: Works out of the box using OAuth authentication, with optional settings available (see [DOCS.md](DOCS.md))
- **Direct Config Access**: Terminal starts in your `/config` directory for immediate access to all Home Assistant files
- **Home Assistant Integration**: Access directly from your dashboard
- **Install as App (PWA)**: Add to your phone's home screen for quick access without browser chrome
- **Panel Icon**: Quick access from the sidebar with the code-braces-box icon
- **Multi-Architecture Support**: Works on amd64 and aarch64 platforms
- **Secure Credential Management**: Persistent authentication with safe credential storage
- **Automatic Recovery**: Built-in fallbacks and error handling for reliable operation

### Enhanced Features (Pro)
- **Persistent Package Management**: Install APK and pip packages that survive container restarts
- **Auto-Install Configuration**: Configure packages to install automatically on startup
- **Python Virtual Environment**: Isolated Python environment in `/data/packages`
- **Simple Commands**: Use `persist-install` for easy package management
- **Persistent Storage**: All packages stored in `/data` which survives all reboots

## Quick Start

The terminal automatically starts Claude when you open it. You can immediately start using commands like:

```bash
# Ask Claude a question directly
claude "How can I write a Python script to control my lights?"

# Start an interactive session (run claude with no arguments)
claude

# Get help with available commands
claude --help

# Debug authentication if needed
claude-auth debug

# Log out and re-authenticate
claude-logout
```

## Installation

1. Add this repository to your Home Assistant app store:
   - Go to Settings → Apps → App Store
   - Click the menu (⋮) and select Repositories
   - Add: `https://github.com/owine/claude-terminal-home-assistant`
2. Install the Claude Terminal Prowine app
3. Start the app
4. Click "OPEN WEB UI" or the sidebar icon to access
5. On first use, follow the OAuth prompts to log in to your Anthropic account

## Configuration

The app works with zero configuration out of the box, with optional settings available (see [DOCS.md](DOCS.md#configuration) for the full list of options):

- **Port**: Web interface and HA ingress run on port 7680 (the internal ttyd terminal uses 7681)
- **Authentication**: OAuth with Anthropic (credentials stored securely in `/config/claude-config/`)
- **Terminal**: Full bash environment with Claude Code CLI pre-installed
- **Volumes**: Access to your Home Assistant `/config` directory

## Troubleshooting

### Authentication Issues
If you have authentication problems:
```bash
claude-auth debug    # Show credential status
claude-logout        # Clear credentials and re-authenticate
```

### Container Issues
- Credentials are automatically saved and restored between restarts
- Check app logs if the terminal doesn't load
- Restart the app if Claude commands aren't recognized

### Development
For local development and testing:
```bash
# Build and run locally (replace amd64 with aarch64 for ARM)
docker build --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.24 \
  -t local/claude-terminal-prowine ./claude-terminal
docker run -p 7680:7680 -p 7681:7681 -v "$(pwd)/config:/config" local/claude-terminal-prowine

# Lint and validate
hadolint claude-terminal/Dockerfile
curl -X GET http://localhost:7680/  # 7680 = web UI/ingress (7681 is internal ttyd)
```

## Architecture

- **Base Image**: Home Assistant Alpine Linux base (3.24)
- **Container Runtime**: Docker
- **Web Terminal**: ttyd (v1.7.7) for browser-based access
- **Session Persistence**: tmux for terminal session management
- **Wrapper Service**: Express.js server for UI, terminal proxy, image uploads, and mouse mode toggle
- **Networking**: Ingress support with Home Assistant reverse proxy

## Security

Security features and improvements:
- **Secure Credential Management**: Limited filesystem access to safe directories only
- **Safe Cleanup Operations**: No dangerous system-wide file deletions
- **Proper Permission Handling**: Consistent file permissions (600) for credentials
- **Input Validation**: Enhanced error checking and bounds validation
- **Binary Verification** (v1.5.0+): SHA256 checksums verified for Claude Code, uv, and GitHub CLI
- **Image Signing** (v1.3.0+): Published images cryptographically signed with cosign

## Development Environment

**Requirements for development:**
- Docker (container runtime)
- Linters: `hadolint`, `shellcheck`, `yamllint`, `actionlint`, `ruff`, and Node.js (`brew install hadolint shellcheck yamllint actionlint ruff node`)

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [.github/LINTING.md](../.github/LINTING.md) for the full build, run, and lint commands.

## Documentation

For detailed usage instructions, see the [documentation](DOCS.md).

## Version History

This add-on uses automated release management. For the current version and complete changelog, see [CHANGELOG.md](CHANGELOG.md).

## Useful Links

- [Claude Code Documentation](https://docs.anthropic.com/claude/docs/claude-code)
- [Get an Anthropic API Key](https://console.anthropic.com/)
- [Claude Code GitHub Repository](https://github.com/anthropics/claude-code)
- [Home Assistant Apps](https://www.home-assistant.io/addons/)

## Credits

A personal fork by [@owine](https://github.com/owine), built on the original **Claude Terminal** by Tom Cassady ([@heytcass](https://github.com/heytcass)) and the enhanced fork by Javier Santos ([@esjavadex](https://github.com/esjavadex)). For the full credits list, see the [repository README](https://github.com/owine/claude-terminal-home-assistant#credits).

## License

This project is licensed under the MIT License - see the [LICENSE](../LICENSE) file for details.