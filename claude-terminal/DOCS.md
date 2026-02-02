# Claude Terminal Prowine

An enhanced terminal interface for Anthropic's Claude Code CLI in Home Assistant.

## About

Claude Terminal Prowine is an enhanced fork of the original Claude Terminal add-on, providing a web-based terminal with Claude Code CLI pre-installed plus persistent package management capabilities. Access Claude's powerful AI capabilities directly from your Home Assistant dashboard with the added benefit of installing and persisting custom packages across restarts.

## Installation

1. Add this repository to your Home Assistant add-on store:
   - Go to Settings → Add-ons → Add-on Store
   - Click the menu (⋮) and select Repositories
   - Add: `https://github.com/esjavadex/claude-code-ha`
2. Install the Claude Terminal Prowine add-on
3. Start the add-on
4. Click "OPEN WEB UI" to access the terminal
5. On first use, follow the OAuth prompts to log in to your Anthropic account

## Configuration

The add-on offers several configuration options:

### Auto Launch Claude
- **Default**: `true`
- When enabled, Claude starts automatically when you open the terminal
- When disabled, shows an interactive session picker menu

### Dangerously Skip Permissions
- **Default**: `false`
- When enabled, Claude runs with `--dangerously-skip-permissions` flag
- **⚠️ WARNING**: This gives Claude unrestricted file system access
- Use only if you understand the security implications
- Useful for advanced users who need full file access

### Persistent Packages
- Configure APK and pip packages to auto-install on startup
- Packages are stored in `/data/packages` and survive restarts

**Example Configuration**:
```yaml
auto_launch_claude: false
dangerously_skip_permissions: true
persistent_apk_packages:
  - python3
  - git
persistent_pip_packages:
  - requests
```

Your OAuth credentials are stored in the `/config/claude-config` directory and will persist across add-on updates and restarts, so you won't need to log in again.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `auto_launch_claude` | `true` | Automatically start Claude when opening the terminal |
| `enable_ha_mcp` | `true` | Enable Home Assistant MCP server integration |
| `persistent_apk_packages` | `[]` | APK packages to install on every startup |
| `persistent_pip_packages` | `[]` | Python packages to install on every startup |

## Usage

Claude launches automatically when you open the terminal. You can also start Claude manually with:

```bash
claude
```

### Common Commands

- `claude -i` - Start an interactive Claude session
- `claude --help` - See all available commands
- `claude "your prompt"` - Ask Claude a single question
- `claude process myfile.py` - Have Claude analyze a file
- `claude --editor` - Start an interactive editor session

The terminal starts directly in your `/config` directory, giving you immediate access to all your Home Assistant configuration files. This makes it easy to get help with your configuration, create automations, and troubleshoot issues.

## Features

### Core Features
- **Web Terminal**: Access a full terminal environment via your browser
- **Auto-Launching**: Claude starts automatically when you open the terminal
- **Claude AI**: Access Claude's AI capabilities for programming, troubleshooting and more
- **Direct Config Access**: Terminal starts in `/config` for immediate access to all Home Assistant files
- **Simple Setup**: Uses OAuth for easy authentication
- **Home Assistant Integration**: Access directly from your dashboard
- **Home Assistant MCP Server**: Built-in integration with [ha-mcp](https://github.com/homeassistant-ai/ha-mcp) for natural language control

## Home Assistant MCP Integration

This add-on includes the [homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp) MCP server, enabling Claude to directly interact with your Home Assistant instance using natural language.

### What You Can Do

- **Control Devices**: "Turn off the living room lights", "Set the thermostat to 72°F"
- **Query States**: "What's the temperature in the bedroom?", "Is the front door locked?"
- **Manage Automations**: "Create an automation that turns on the porch light at sunset"
- **Work with Scripts**: "Run my movie mode script", "Create a script for my morning routine"
- **View History**: "Show me the energy usage for the last week"
- **Debug Issues**: "Why isn't my motion sensor automation triggering?"
- **Manage Dashboards**: "Add a weather card to my dashboard"

### How It Works

The MCP (Model Context Protocol) server automatically connects to your Home Assistant using the Supervisor API. No manual configuration or token setup is required - it just works!

The integration provides 97+ tools for:
- Entity search and control
- Automation and script management
- Dashboard configuration
- History and statistics
- Device registry access
- And much more

### Disabling the Integration

If you don't want the Home Assistant MCP integration, you can disable it in the add-on configuration:

```yaml
enable_ha_mcp: false
```

### Enhanced Features (Pro)
- **Persistent Packages**: Install system (APK) and Python (pip) packages that survive restarts
- **Auto-Install Configuration**: Set packages to auto-install on startup
- **Simple Management**: Use `persist-install` command for easy package installation
- **Python Virtual Environment**: Isolated Python environment in `/data/packages`

## Troubleshooting

- If Claude doesn't start automatically, try running `claude -i` manually
- If you see permission errors, try restarting the add-on
- If you have authentication issues, try logging out and back in
- Check the add-on logs for any error messages

## Credits

**Original Creator:** Tom Cassady ([@heytcass](https://github.com/heytcass))
**Fork Maintainer:** Javier Santos ([@esjavadex](https://github.com/esjavadex))

This add-on was created and enhanced with the assistance of Claude Code itself! The development process, debugging, and documentation were all completed using Claude's AI capabilities - a perfect demonstration of what this add-on can help you accomplish.