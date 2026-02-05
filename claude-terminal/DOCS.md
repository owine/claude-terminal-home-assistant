# Claude Terminal Prowine

An enhanced terminal interface for Anthropic's Claude Code CLI in Home Assistant.

## About

Claude Terminal Prowine is an enhanced fork of the original Claude Terminal add-on, providing a web-based terminal with Claude Code CLI pre-installed plus persistent package management capabilities. Access Claude's powerful AI capabilities directly from your Home Assistant dashboard with the added benefit of installing and persisting custom packages across restarts.

## Installation

1. Add this repository to your Home Assistant add-on store:
   - Go to Settings → Add-ons → Add-on Store
   - Click the menu (⋮) and select Repositories
   - Add: `https://github.com/owine/claude-terminal-home-assistant`
2. Install the Claude Terminal Prowine add-on
3. Start the add-on
4. Click "OPEN WEB UI" to access the terminal
5. On first use, follow the OAuth prompts to log in to your Anthropic account

## Configuration

The add-on offers several configuration options:

### Auto Launch Claude
- **Default**: `true`
- When enabled, Claude starts automatically when you open the terminal
- When disabled, shows an interactive session picker menu with options for:
  - New interactive session
  - Continue most recent conversation
  - Resume from conversation list
  - Custom Claude commands
  - Authentication helper
  - GitHub CLI login
  - Drop to bash shell (with `menu` alias to return)

### Dangerously Skip Permissions
- **Default**: `false`
- When enabled, Claude runs with `--dangerously-skip-permissions` flag
- **⚠️ WARNING**: This gives Claude unrestricted file system access
- Use only if you understand the security implications
- Useful for advanced users who need full file access

### YOLO Mode (Session Picker Option 9)

YOLO Mode provides on-demand access to `--dangerously-skip-permissions` without enabling it globally in your configuration.

**When to Use:**
- You need unrestricted file access for a single session
- You want to test automation scripts without permission prompts
- You prefer keeping the global setting disabled for safety
- You understand the security implications and accept the risks

**How It Works:**
1. Select option 9 from the session picker menu
2. Read the warning screen explaining the risks
3. Type "YOLO" (case-sensitive) to confirm
4. Choose your session type (New/Continue/Resume)
5. Claude launches with `--dangerously-skip-permissions`
6. Returns to menu when Claude session ends

**Security Notes:**
- `IS_SANDBOX=1` is set automatically during YOLO sessions
- The flag only applies to the current session (not persistent)
- Must type "YOLO" exactly - any other input cancels
- Invalid sub-menu choices safely return to menu

**YOLO Mode vs Global Config:**

| Aspect | YOLO Mode (Option 9) | Global Config Setting |
|--------|---------------------|---------------------|
| Scope | Single session | All sessions |
| Persistence | None | Survives restarts |
| Requires confirmation | Yes ("YOLO" typing) | No |
| Use case | Occasional need | Always unrestricted |

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
| `dangerously_skip_permissions` | `false` | Run Claude with unrestricted file access ⚠️ |
| `enable_ha_mcp` | `true` | Enable Home Assistant MCP server integration |
| `tmux_mouse_mode` | `false` | Enable mouse support in tmux (use Shift+select to copy) |
| `persistent_apk_packages` | `[]` | APK packages to install on every startup |
| `persistent_pip_packages` | `[]` | Python packages to install on every startup |

## Usage

Claude launches automatically when you open the terminal (if `auto_launch_claude: true`). When set to `false`, you'll see an interactive session picker menu.

### Session Picker Menu

When the menu is enabled (`auto_launch_claude: false`), you'll see a numbered menu with these options:

1. **New interactive session** - Start a fresh Claude conversation
2. **Continue most recent** - Resume your last conversation (`-c` flag)
3. **Resume from list** - Choose from past conversations (`-r` flag)
4. **Custom command** - Enter manual Claude flags and arguments
5. **Authentication helper** - Debug and fix credential issues
6. **GitHub CLI login** - Authenticate `gh` for repository access
7. **Drop to bash** - Exit to shell (type `menu` to return)
8. **Clear & restart** - Reset tmux scrollback and restart menu
9. **YOLO Mode** - Launch with `--dangerously-skip-permissions` (requires "YOLO" confirmation)

**Tips:**
- If you drop to bash shell, type `menu` to return to the session picker
- Pressing Ctrl+C in the menu shows a reminder to use option 7 to exit
- When Claude exits, you automatically return to the menu

### Manual Claude Commands

```bash
# Start Claude
claude

# Interactive session
claude -i

# Continue most recent conversation
claude -c

# Resume from conversation list
claude -r

# Ask a single question
claude "your prompt"

# Analyze a file
claude process myfile.py

# Get help
claude --help
```

### Common Commands

- `menu` - Return to session picker from bash shell
- `persist-install` - Install packages that survive reboots (see Persistent Packages section)

The terminal starts directly in your `/config` directory, giving you immediate access to all your Home Assistant configuration files. This makes it easy to get help with your configuration, create automations, and troubleshoot issues.

## Features

### Core Features
- **Web Terminal**: Access a full terminal environment via your browser
- **Session Picker**: Interactive menu for starting, continuing, or resuming Claude sessions
- **Menu Alias**: Type `menu` from bash to return to session picker
- **Auto-Launching**: Claude starts automatically when you open the terminal (configurable)
- **Claude AI**: Access Claude's AI capabilities for programming, troubleshooting and more
- **Image Paste Support**: Paste images (Ctrl+V), drag-drop, or upload for Claude analysis
- **Direct Config Access**: Terminal starts in `/config` for immediate access to all Home Assistant files
- **Simple Setup**: Uses OAuth for easy authentication
- **Home Assistant Integration**: Access directly from your dashboard
- **Home Assistant MCP Server**: Built-in integration with [ha-mcp](https://github.com/homeassistant-ai/ha-mcp) for natural language control
- **tmux Session Persistence**: Terminal sessions persist across browser refreshes
- **Persistent Package Management**: Install packages that survive reboots with `persist-install`

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

### Enhanced Features

#### Image Paste Support

Claude Terminal Prowine supports pasting and uploading images directly in the web interface for analysis, OCR, or any other image-related tasks.

##### Usage Methods

**Method 1: Paste (Keyboard)**
1. Copy an image to your clipboard (from screenshot, browser, etc.)
2. Focus on the terminal window
3. Press **Ctrl+V** (or **Cmd+V** on Mac)
4. The image uploads automatically
5. Use the path with Claude: `analyze /data/images/pasted-123456.png`

**Method 2: Drag and Drop**
1. Drag an image file from your file manager
2. Drop it anywhere on the terminal window
3. The image uploads automatically
4. Use the file path shown in the status bar

**Method 3: Upload Button**
1. Click the **📎 Upload Image** button in the top right
2. Select an image file from the file picker
3. The image uploads automatically

##### File Storage

- **Location**: `/data/images/`
- **Persistence**: Images survive container restarts
- **Naming**: Files are automatically named `pasted-<timestamp>.<ext>`
- **Formats**: JPEG, PNG, GIF, WebP, and SVG
- **Size Limit**: 10MB per file

##### Examples

```bash
# Analyze an image
analyze /data/images/pasted-1732374829123.png

# Extract text from screenshot (OCR)
extract the text from /data/images/pasted-1732374829123.png

# Compare images
compare /data/images/pasted-123.png and /data/images/pasted-456.png
```

##### Technical Details

**Architecture:**
- Node.js image upload service runs on port 7680 (main web interface)
- ttyd terminal embedded on port 7681
- Handles uploads via paste, drag-drop, or button click
- Saves to `/data/images/` (persistent storage)

**Dependencies:**
- Express v5.2.1 (HTTP server with security improvements)
- Multer v2.0.2 (multipart/form-data handling, fixes 4 critical CVEs)
- ARM-compatible for Raspberry Pi

**Resource Usage:**
- Memory: ~10-15MB for Node.js service
- CPU: Minimal (only active during uploads)
- Storage: `/data/images/`

**Security:**
- MIME type validation (images only)
- 10MB file size limit
- Isolated storage directory
- No execution permissions on uploaded files

##### Troubleshooting

**Image not uploading:**
- Check browser console for errors (F12)
- Verify file is an image (JPEG, PNG, GIF, WebP, SVG)
- Ensure file is under 10MB
- Check add-on logs

**Can't see uploaded images:**
```bash
ls -la /data/images/          # List images
ls -ld /data/images/          # Check permissions
df -h /data                   # Check disk space
```

**Paste not working:**
- Click on page first to focus it
- Check browser clipboard permissions
- Try drag-drop or upload button instead

**Browser Compatibility:**
- ✅ Chrome/Edge 90+, Firefox 90+, Safari 14+
- ⚠️ Older browsers: use drag-drop or upload button

#### Persistent Package Management
- **System packages**: Install APK packages that survive restarts
- **Python packages**: Install pip packages in persistent virtual environment
- **Auto-install**: Configure packages to install automatically on startup
- **Simple command**: Use `persist-install` for all package management
- **Storage location**: `/data/packages/` (permanent storage)

See [PERSISTENT_PACKAGES.md](PERSISTENT_PACKAGES.md) for complete guide.

#### Session Management
- **Interactive menu**: Choose between new, continue, or resume sessions
- **GitHub CLI**: Pre-installed with persistent authentication
- **tmux integration**: Sessions persist across browser refreshes
- **Mouse support**: Optional tmux mouse mode (configurable)

## Troubleshooting

- If Claude doesn't start automatically, try running `claude -i` manually
- If you see permission errors, try restarting the add-on
- If you have authentication issues, try logging out and back in
- Check the add-on logs for any error messages

## Credits

**Original Creator:** Tom Cassady ([@heytcass](https://github.com/heytcass))
**Fork Maintainer:** Javier Santos ([@esjavadex](https://github.com/esjavadex))

This add-on was created and enhanced with the assistance of Claude Code itself! The development process, debugging, and documentation were all completed using Claude's AI capabilities - a perfect demonstration of what this add-on can help you accomplish.