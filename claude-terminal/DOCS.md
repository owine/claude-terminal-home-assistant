# Claude Terminal Prowine

An enhanced terminal interface for Anthropic's Claude Code CLI in Home Assistant.

## About

Claude Terminal Prowine is a personal fork by [@owine](https://github.com/owine), built on the original **Claude Terminal** by Tom Cassady ([@heytcass](https://github.com/heytcass)) and the enhanced **claude-code-ha** fork by Javier Santos ([@esjavadex](https://github.com/esjavadex)). It provides a web-based terminal with Claude Code CLI pre-installed plus persistent package management capabilities. Access Claude's powerful AI capabilities directly from your Home Assistant dashboard with the added benefit of installing and persisting custom packages across restarts. For full credits, see the [repository README](https://github.com/owine/claude-terminal-home-assistant#credits).

## Installation

1. Add this repository to your Home Assistant app store:
   - Go to Settings → Apps → App Store
   - Click the menu (⋮) and select Repositories
   - Add: `https://github.com/owine/claude-terminal-home-assistant`
2. Install the Claude Terminal Prowine app
3. Start the app
4. Click "OPEN WEB UI" to access the terminal
5. On first use, follow the OAuth prompts to log in to your Anthropic account

## Configuration

The app offers several configuration options:

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

YOLO Mode is a **per-session confirmation gate** for `--dangerously-skip-permissions`. It only appears when you have already enabled `dangerously_skip_permissions: true` in the app configuration (that setting is what exports `ALLOW_YOLO_MODE=1`, which makes option 9 visible in the session picker). It is **not** a way to get unrestricted access while keeping the global setting off.

Its purpose is to let you decide **per session** when the dangerous flag is applied, rather than having every session launch with it automatically. With the global setting enabled, you launch individual sessions with `--dangerously-skip-permissions` on demand after a typed confirmation.

**Requirements:**
- `dangerously_skip_permissions: true` must be set in the app configuration
- Without it, option 9 does not appear and YOLO Mode is unavailable

**When to Use:**
- You have enabled the global dangerous-permissions setting but want each unrestricted session to be an explicit, confirmed choice
- You want to test automation scripts without permission prompts for a single session
- You understand the security implications and accept the risks

**How It Works:**
1. Select option 9 from the session picker menu (only shown when `dangerously_skip_permissions: true`)
2. Read the warning screen explaining the risks
3. Type "YOLO" (case-sensitive) to confirm
4. Choose your session type (New/Continue/Resume)
5. Claude launches with `--dangerously-skip-permissions`
6. Returns to menu when Claude session ends

**Security Notes:**
- `IS_SANDBOX=1` is set automatically during YOLO sessions
- Must type "YOLO" exactly - any other input cancels
- Invalid sub-menu choices safely return to menu

**YOLO Mode (Option 9) vs. Auto-Launch with the Global Flag:**

Both require `dangerously_skip_permissions: true`. The difference is how the flag is applied:

| Aspect | YOLO Mode (Option 9) | Auto-applied to every session |
|--------|---------------------|---------------------|
| Availability | Requires `dangerously_skip_permissions: true` | Requires `dangerously_skip_permissions: true` |
| Applied per session | Only after a typed "YOLO" confirmation | Automatically to every session |
| Requires confirmation | Yes ("YOLO" typing) | No |
| Use case | Explicit, confirmed unrestricted sessions | Always unrestricted |

### Persistent Packages
- Configure APK and pip packages to auto-install on startup
- Packages are stored in `/data/packages` and survive restarts

### Init Commands

`init_commands` is a list of shell commands run on every start of the app,
after persistent packages and the Docker CLI are installed and before the
terminal opens. Use it to start something that should be running whether or
not anyone has the terminal open.

```yaml
init_commands:
  - nohup /config/my-bridge/start.sh > /config/my-bridge/bridge.log 2>&1 &
  - git -C /share/projects/notes pull --ff-only
```

- Commands run as **root**, one at a time, in `bash`, from `/config`.
- Each command gets **120 seconds**. After that its shell is stopped and a
  warning is logged, so a mistake can't hold the terminal back. Programs the
  shell started may keep running: in `npm ci && npm run build`, a stuck build
  outlives the timeout.
- A service must put itself in the background with `nohup ... &` **and**
  redirect its own output, as above (`> file.log 2>&1`). Without the redirect
  its output is lost: it goes to a temporary file that is deleted once the
  command returns, while the service keeps writing to it.
- Output goes to the app log (the last 200 lines per command). A command that
  fails logs a warning, and startup carries on.
- The command text and its output are logged, so keep secrets out of both:
  put them in a file under `/config` and have the command source it.
- Only the app configuration is used. Nothing under `/config` is run
  automatically, because other apps can write there.

### Docker Access

The app can optionally provide access to the host Docker socket, letting you manage containers directly from the terminal — including the Home Assistant core container, other app containers, and any Docker workloads running on the host.

**What you can do with Docker access:**
- Run `docker ps`, `docker logs`, `docker exec` against any container on the host
- Start, stop, and restart containers
- Pull images and run new containers
- Use `docker compose` for multi-container workflows
- Build images (requires `enable_docker_buildx: true`)

**⚠️ Security Warning:** Docker socket access grants effectively **root-level access to the host machine**. Anyone with terminal access can escape any container boundary, read any file, or run arbitrary code as root. Only enable this if you fully understand and accept the implications. This risk compounds further if `dangerously_skip_permissions` is also enabled — together they give Claude unrestricted access to the host.

#### Two required steps

Enabling Docker access requires **both** of the following — either alone is not enough:

1. **Set `enable_docker: true`** in the app configuration
2. **Disable Protection Mode** in the app's **Info** tab in the Home Assistant UI

Protection Mode is a per-app HA Supervisor toggle (on by default). While it is on, the host Docker socket is never mounted into the container, regardless of the `enable_docker` setting. You must turn it off explicitly.

#### Optional: Buildx support

Set `enable_docker_buildx: true` to also install `docker buildx`, enabling multi-platform image builds. This has no effect unless `enable_docker: true` is also set.

#### Package installation note

When `enable_docker: true`, the app installs `docker-cli` and `docker-cli-compose` (and `docker-cli-buildx` if enabled) at every start, through `persist-install`'s apk cache, so they survive restarts — `docker compose` and `docker buildx` included. They are not added to your recorded package list, so turning the option off stops installing them. The version installed floats to whatever Alpine's package repos currently provide — consistent with how all `persist-install` packages behave (not version-pinned, not Renovate-tracked).

#### Troubleshooting Docker access

- **`docker: command not found`** — `enable_docker` is off, or package installation failed on the last startup. Check the app log for `persist-install` errors and restart the app.
- **`Cannot connect to the Docker daemon` / socket not found** — Protection Mode is still ON. The Docker socket is not mounted into the container until you disable Protection Mode in the app's **Info** tab.

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

Your OAuth credentials are stored in the app's private `/data` volume (Claude Code's own config directory, `/data/home/.claude/`) and persist across app updates and restarts, so you won't need to log in again. `/data` is not visible from your Home Assistant `/config` share. Very old versions kept credentials in `/config/claude-config`. They are carried over once, on the first start after upgrading, and never over a login you already have; after that the directory can be deleted.

### Shared Folder Access

The terminal mounts `/share`, the folder Home Assistant and other apps use to
exchange files, read-write. It is a natural place to keep projects that are not
Home Assistant configuration, and a convenient handoff point for files produced
by other apps. Point `working_directory` at a path under `/share` if that is
where you usually work.

### App Config Access

In addition to your Home Assistant config at `/config`, the terminal mounts every
installed app's configuration directory under `/addon_configs/<repo>_<slug>/`
(the `all_app_configs` mapping, kept at the path it has always had). This lets Claude read
and edit other apps' configs from one place — for example inspecting another
app's YAML while wiring up an integration.

⚠️ **Security note:** This mapping is **always on** and **read-write** to *all*
app configs — it cannot be toggled off via an option, because Home Assistant
applies volume mounts statically at container creation. It widens the terminal's
reach and compounds with `dangerously_skip_permissions` (YOLO mode) and Docker
socket access.

**Why read-write?** The mount is read-write so Claude can actually *edit* other
apps' configs — the primary use case for this feature (fixing YAML, wiring up
integrations). A read-only mount would only allow inspection, which the Home
Assistant config UI already provides, so it would add reach without adding
capability. If you only need to read other configs, treat the mount as read-only
by convention and avoid asking Claude to modify those paths.

**Residual risk even with YOLO disabled:** Outside YOLO mode, Claude Code prompts
for permission before reading or writing paths outside its working directory, so
*interactive* access to `/addon_configs` stays gated by those prompts. But the
mount itself is always present and writable at the filesystem level — so anything
running in the container (or any compromise of the terminal app) can read and
modify every app's configuration regardless of those prompts. If that blast
radius is not acceptable for your setup, this app is not a good fit; the
mapping cannot be disabled without forking the app.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `auto_launch_claude` | `true` | Automatically start Claude when opening the terminal |
| `dangerously_skip_permissions` | `false` | Run Claude with unrestricted file access ⚠️ |
| `enable_ha_mcp` | `true` | Enable Home Assistant MCP server integration |
| `working_directory` | `""` | Directory the terminal session starts in. Empty means `/config`, which is where it already started. A path that does not exist logs a warning and falls back to `/config` |
| `claude_code_oauth_token` | `""` | Token from `claude setup-token`, for logging in without the browser OAuth flow. Masked in the UI and never logged. See Authentication below |
| `login_notification` | `true` | Post Claude's login link as a Home Assistant notification while a browser login is waiting, and dismiss it once the login succeeds. See Authentication below |
| `tmux_mouse_mode` | `true` | Mouse reporting: the wheel scrolls and a drag selects. Set `false` to disable it entirely (the wheel then sends arrow keys to full-screen apps). Flip it live with **Prefix + m**. **Changed in 2.7.3** — this defaulted to `false` before, so if you never set it, the mouse became active on upgrade |
| `persist_npm_cache` | `false` | Keep the npm cache in persistent `/data` storage. Default (`false`) puts it in ephemeral `/tmp` so it stays out of HA backups; set `true` only if you want the cache to survive restarts |
| `image_retention_days` | `30` | Pasted and dropped images older than this many days are deleted at startup. Only the app's own uploads (`pasted-*` in `/data/images`) are touched. `0` keeps them forever, and so does a value over 36500 (100 years), with a warning in the log. `/data` is included in every Home Assistant backup, so this also bounds backup growth. Caches and the Claude binary are always left out of backups; after a restore the app reinstalls the Claude version bundled with the image, and Claude updates itself again from there |
| `upload_max_mb` | `25` | Largest file, in megabytes, uploaded into `/config`, from 1 to at most 1024: from the Files sidebar, and from the terminal (📎, paste, drop) for everything but small images, which go to `/data/images` with their own 10 MB limit. See Uploads under Files Sidebar, and Uploading Files from the Terminal |
| `upload_retention_days` | `30` | Files in the sidebar's upload inbox, `/config/uploads`, last modified more than this many days ago are deleted at startup: every file at the inbox's top level, whatever its name and whoever put it there. Folders and symlinks in it are never removed. Only an inbox the app made is swept: it marks one with a hidden file, `.ctp-inbox`, and a `/config/uploads` without that marker (a folder of yours that was there first) is left alone, with a line in the log. From 0 to at most 36500 (100 years); `0` keeps them forever. A folder you chose with **Upload here** is never swept. See Uploads under Files Sidebar |
| `persistent_apk_packages` | `[]` | APK packages to install on every startup |
| `persistent_pip_packages` | `[]` | Python packages to install on every startup |
| `init_commands` | `[]` | Shell commands run as root on every start, 120 seconds each. See Init Commands above |
| `enable_docker` | `false` | Install the Docker CLI and enable host Docker socket access (requires Protection Mode disabled) ⚠️ |
| `enable_docker_buildx` | `false` | Also install `docker buildx` for image builds (only meaningful with `enable_docker`) |

### Authentication

By default Claude prompts you to log in through your browser the first time you
use it. That flow requires copying a long URL out of the terminal, which the
browser clipboard does not always carry intact.

Two things help with that:

- **Home Assistant notification**: while Claude is waiting for a login, the
  app posts the link as a "Claude Code login" notification, which also
  reaches the Companion app. Open it, sign in, then paste the code the browser
  shows into the terminal. While nothing needs it, the app checks for a
  login screen less often, so the first notification can take up to 30
  seconds to arrive. The notification goes away by itself once the login
  succeeds, or once the login screen is gone (a cancelled login, or a Console
  login, which does not leave the credentials it watches for). Notifications
  live in Home Assistant's memory, so if HA restarts mid-login the same link
  is not posted again; use the banner below instead. Turn it off with
  `login_notification: false`.
- **The "Login link ready" banner** in the app's web UI, with Open and Copy
  buttons for the same link, whenever the terminal is open in a browser.

The code still has to be pasted into the terminal either way: Claude receives
it through a callback inside the container, which your browser cannot reach.
Notifications are visible to every Home Assistant user, not only admins, but
the link alone cannot log anyone in without that terminal.

To skip the browser login entirely, set `claude_code_oauth_token` (no
notification is posted then):

1. On a machine where you are already logged in to Claude Code, run
   `claude setup-token`
2. Paste the resulting token into the `claude_code_oauth_token` app option
3. Restart the app

The token is passed to Claude through the environment only — it is never
written into the container's profile scripts or into `/data`, and it is masked
in the Home Assistant UI and absent from the app log.

Note: token authentication cannot establish Remote Control sessions. If you
need those, use the interactive browser login instead.

## Usage

Claude launches automatically when you open the terminal (if `auto_launch_claude: true`). When set to `false`, you'll see an interactive session picker menu.

### Session Picker Menu

When the menu is enabled (`auto_launch_claude: false`), you'll see a numbered menu. Options 1-8 are always shown; option 9 appears **only** when `dangerously_skip_permissions: true` is set in the app configuration:

1. **New interactive session** - Start a fresh Claude conversation
2. **Continue most recent** - Resume your last conversation (`-c` flag)
3. **Resume from list** - Choose from past conversations (`-r` flag)
4. **Custom command** - Enter manual Claude flags and arguments
5. **Authentication helper** - Debug and fix credential issues
6. **GitHub CLI login** - Authenticate `gh` for repository access
7. **Drop to bash** - Exit to shell (type `menu` to return)
8. **Clear & restart** - Reset tmux scrollback and restart menu
9. **YOLO Mode** - Launch with `--dangerously-skip-permissions` (requires "YOLO" confirmation; shown only when `dangerously_skip_permissions: true`)

**Tips:**
- If you drop to bash shell, type `menu` to return to the session picker
- Pressing Ctrl+C in the menu shows a reminder to use option 7 to exit
- When Claude exits, you automatically return to the menu

### Manual Claude Commands

```bash
# Start Claude (running claude with no arguments starts an interactive session)
claude

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
- `claude-doctor` - Diagnose environment problems: memory and disk in `/data`, CPU
  AVX support, directory permissions, Node.js, and whether the Claude binary is
  both present and actually runnable

The terminal starts directly in your `/config` directory, giving you immediate access to all your Home Assistant configuration files. This makes it easy to get help with your configuration, create automations, and troubleshoot issues. Set `working_directory` if you would rather start somewhere else — for example `/addon_configs/<repo>_<slug>` or a project directory under `/share`. Claude Code asks once to trust a directory the first time you use it, then remembers.

## Features

### Core Features
- **Web Terminal**: Access a full terminal environment via your browser
- **Install as App (PWA)**: Add to your phone's home screen for instant access without browser chrome
- **Session Picker**: Interactive menu for starting, continuing, or resuming Claude sessions
- **Menu Alias**: Type `menu` from bash to return to session picker
- **Auto-Launching**: Claude starts automatically when you open the terminal (configurable)
- **Claude AI**: Access Claude's AI capabilities for programming, troubleshooting and more
- **File Uploads from the Terminal**: Paste (Ctrl+V), drop or pick (📎) any file, and its path is typed at the prompt for Claude
- **Files Sidebar**: Browse, preview and download files in `/config` (folders as a zip), see recently changed files, and run Home Assistant's configuration check
- **Direct Config Access**: Terminal starts in `/config` for immediate access to all Home Assistant files
- **Simple Setup**: Uses OAuth for easy authentication
- **Home Assistant Integration**: Access directly from your dashboard
- **Home Assistant MCP Server**: Built-in integration with [ha-mcp](https://github.com/homeassistant-ai/ha-mcp) for natural language control
- **tmux Session Persistence**: Terminal sessions persist across browser refreshes
- **Persistent Package Management**: Install packages that survive reboots with `persist-install`

## Home Assistant MCP Integration

This app includes the [homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp) MCP server, enabling Claude to directly interact with your Home Assistant instance using natural language.

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

The integration provides dozens of tools for:
- Entity search and control
- Automation and script management
- Dashboard configuration
- History and statistics
- Device registry access
- And much more

### Disabling the Integration

If you don't want the Home Assistant MCP integration, you can disable it in the app configuration:

```yaml
enable_ha_mcp: false
```

### Install as App (PWA)

Claude Terminal can be installed as a Progressive Web App on your phone or tablet for quick access without opening a browser.

#### How to Install

**iOS (Safari):**
1. Open Claude Terminal in Safari
2. Tap the Share button (square with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Tap "Add"

**Android (Chrome):**
1. Open Claude Terminal in Chrome
2. Tap the menu (⋮) in the top right
3. Tap "Add to Home screen" or "Install app"
4. Tap "Install"

**Desktop (Chrome/Edge):**
1. Open Claude Terminal in Chrome or Edge
2. Click the install icon in the address bar (or menu → "Install Claude Terminal Prowine")
3. Click "Install"

#### Access Methods

The PWA works with any of these access methods:
- **HA external URL**: Through Home Assistant's sidebar (via Nabu Casa or reverse proxy)
- **Custom reverse proxy**: e.g., `https://claude.yourdomain.com`
- **Direct port**: `http://your-ha-ip:7680` — off by default, see the warning below

**Tip:** For the most reliable PWA experience, install via a stable URL (reverse proxy, or the direct port) rather than HA ingress. Ingress tokens can rotate, which may require re-adding the app.

> [!WARNING]
> **The direct port has no authentication.** Ingress is gated by your Home
> Assistant login; port 7680 is not gated by anything. The web UI proxies
> straight through to a writable terminal attached to a root shell with access
> to `/config`, `/share`, every app's config, and — if you enabled it — the
> host Docker socket. Anyone who can reach `http://your-ha-ip:7680` has all of
> that, with no password.
>
> The app does refuse terminal connections opened by *other websites*, so a
> page someone on your LAN visits cannot reach the terminal through their
> browser. That closes the browser route only — anything that connects to the
> port directly still gets in.
>
> That is why the port is **not published by default**. To turn it on, open the
> app's **Configuration → Network** section, set **7680** as the host port,
> and save. Only do this on a network you trust, or put an authenticating
> reverse proxy in front of it — never forward this port to the internet.
>
> **Upgrading from 2.8.5 or earlier?** The port used to be published by
> default. If you reach the app at `http://your-ha-ip:7680` (including a PWA
> installed from that URL) and it stops loading after the upgrade, re-add the
> port as above — your setup still works, it just has to be asked for now.

#### Offline Support

When your network is unavailable, the app shows a branded offline page with a retry button instead of a browser error. The terminal requires a live connection to function, so reconnect and tap "Retry Connection" to resume.

### Enhanced Features

#### Uploading Files from the Terminal

Any file can go from your device to the app straight from the terminal,
and its path is typed at the prompt for you to use with Claude:

- **Paste** (Ctrl+V, or Cmd+V on a Mac) a screenshot, a copied image or a
  copied file, with the terminal or anything else on the page focused,
  except the Files sidebar: a paste with focus there is a sidebar upload,
  and one with a file preview open is refused (see Uploads under Files
  Sidebar). A clipboard that also holds plain text pastes that
  text instead (copied spreadsheet cells, for example, come with a picture
  of themselves).
- **Drop** files anywhere on the terminal.
- **📎** in the header opens a file picker; pick one file or several.

Where a file goes depends on what it is:

| File | Goes to | Limit |
|---|---|---|
| A PNG, JPEG, GIF, WebP or SVG image of at most 10 MB | `/data/images/`, under a name the app picks (`pasted-<time>-<random>.png`) | 10 MB |
| Anything else: other types, HEIC photos, bigger images | The upload inbox, `/config/uploads/`, under its own name | `upload_max_mb` (25 MB unless you change it) |

Paths are typed at the prompt without pressing Enter, so you can add to the
command before you run it. A name with spaces or other characters the shell
would read is quoted (`'/config/uploads/my report.pdf'`). Several files are
typed in the order they came, separated by spaces. If the terminal cannot take
the text (still loading, say), the paths are copied to the clipboard instead,
or shown in the status bar if that fails too. Folders cannot be dropped: drop
the files inside them.

Progress and refusals show in the status bar beside the header buttons. A
refusal says why: a file over `upload_max_mb` is refused before any of it is
sent, and the message names the limit. It stays until the next message.
Uploads are limited in rate: when the app answers "too many uploads", the
batch stops at that file, and the status bar says how many were not uploaded.
Wait a minute and send those again.

Both places are cleared at startup. `/data/images/` loses the app's own
`pasted-*` files once they are older than `image_retention_days`. **The inbox
is disposable:** every file at its top level is deleted once it is older than
`upload_retention_days`, whoever put it there, if the app made the folder
(see Uploads under Files Sidebar). A name already taken in the inbox gets a
number (`report (1).pdf`); nothing is overwritten. Move files you want to
keep somewhere else in `/config`.

```bash
# Use a typed path with Claude
analyze /data/images/pasted-1732374829123-1a2b3c4d.png
summarise '/config/uploads/my report.pdf'
```

##### Troubleshooting

**A file did not upload:** the status bar says why. The app's log may say
more; check that the disk is not full (`df -h /data /config`).

**A paste uploads nothing, or a copied file pastes as its name:** the
clipboard holds plain text as well as the file, and plain text wins (see
above). Some browsers put a copied file's name on the clipboard that way.
Drop the file or pick it with 📎 (Upload file) instead.

**Browsers:** tested in Chromium-based browsers and Safari (WebKit).

#### Files Sidebar

The **🗂️** button in the header opens a sidebar on the right of the terminal.
Hide it with **»** and it shrinks to a thin rail with buttons to open it again;
drag its left edge to resize it. It remembers whether it was open and how wide
it was. On a phone it covers the terminal while open and is out of the way
entirely when closed.

- **Files** is a tree of `/config`. Click a file to preview it, then **Insert
  path** types its path at the prompt (quoted if it has spaces, never followed
  by Enter) so you can hand it to Claude. **Copy path** puts it on the
  clipboard, and **Download** saves the file to your device. Each folder row
  has a **⋯** button with **Download as zip** and **Upload here**, and
  **⬆️ Upload** puts files in `/config/uploads` (see Uploads below). Dotfiles
  appear when you tick **Hidden files**.
- **Recent changes** lists the files in `/config` changed in the last hour,
  day or week, newest first, so you can see what Claude just edited. What Home
  Assistant rewrites by itself is left out: `.storage`, `deps`, `tts`,
  `backups`, databases and logs. So are build and dependency folders
  (`node_modules`, `venv`, `.venv`, `__pycache__`, ESPHome's `.esphome/build`,
  `.pio`), which would otherwise crowd out real edits.
- **✓ Check HA configuration** runs `ha core check` and shows the result, so
  you can validate an edit before restarting Home Assistant.

Apart from uploads, the sidebar changes nothing, and it is limited to `/config`. Paths are resolved through
symlinks and must stay inside it, so `/data`, where your Claude login lives, is
not reachable. Which files it shows follows Studio Code Server's defaults:

- `.git`, and any folder ending in `.git` (a bare repository), is never
  listed, previewed, downloaded or zipped: remote URLs in its `config` can carry access tokens.
- `secrets.yaml` is an ordinary file: listed, previewed, downloaded and zipped
  like any other.
- Files that are typically credentials are listed with a 🔒, and are not
  previewed or downloaded unless **Show protected files** is on (see below):
  `.storage`, `.cloud`, `.ssh`, `.gnupg`, `claude-config`, `.env`
  files and `.envrc`, Google Assistant's `service_account.json`, keys and
  certificates (`*.key`, `*.pem`, `*.p12`, `id_rsa` and
  friends), `.git-credentials`, `.gitconfig`, `.netrc`, `.npmrc`, `.pypirc`,
  and Claude Code's own `.credentials.json` and `.claude.json`. A symlink to
  one of these gets the 🔒 too.
- An upload still being written (`.ctp-upload-*.part`) is not listed. Any
  other `*.part` file is an ordinary file, listed and zipped like the rest.
- A name that is not valid UTF-8 (Linux allows almost any bytes in a name;
  such names usually come from old archives or other systems) cannot be shown
  or asked for, so it is left out of the listing, recent changes and zips,
  with everything inside such a folder. It is counted as a name that could
  not be read rather than dropped silently; recent changes counts every such
  name its search passed, however old, since without the name it cannot tell
  when the file changed. In the terminal `ls` shows it with `?` in place of
  those bytes; rename it there to bring it back.

Previews show at most the first 256 KB of a file, as plain text; binary files
are recognised and not shown. A folder lists at most 1000 entries.

**Show protected files.** Tick it to preview and download the files marked
🔒. An amber strip across the sidebar stays up while it is on. Nothing
remembers it: it is off again every time the page loads. It shows on the Files
tab, and on Recent changes while it is on. Turning it off closes any protected
preview that is open. It works with **Hidden files**: most protected entries
are dotfiles, so to open `.storage/auth`, tick **Hidden files** to see
`.storage` and **Show protected files** to open what is inside. `.git` stays
unavailable either way.

**Downloads.** **Download** in a file's preview saves the file as it is. A file
reached through a symlink is saved under the name you clicked, not the name of
its target. **Download as zip** in a folder's **⋯** menu packs the folder and
everything below it, by these rules:

- Protected files and folders, `.git`, symlinks and uploads still being
  written are never put in a zip, even with **Show protected files** on, and a protected
  folder's **Download as zip** is disabled. A symlinked folder zipped from its
  own **⋯** packs the folder it points to, under the name you clicked; it is
  only symlinks *inside* the folder being zipped that are left out.
- A zip holds at most 200 MB before compression. A bigger folder is refused,
  and the message in the sidebar names its largest files so you can zip the
  parts you need. There is no zip of all of `/config` (the recorder database,
  `home-assistant_v2.db`, is usually over the limit on its own); use Home
  Assistant's backups for that.
- A folder with more than 20,000 entries, nested more than 8 levels deep, or
  that takes more than 3 seconds to list, is refused too.
- Two zips can be prepared or sent at once. A third does not start; the
  sidebar says so, and you can try again when one has finished.
- Within each folder, files come first and then subfolders, each sorted by
  name (capital letters before lowercase ones). Empty folders are left out.
  Photos, video, audio, archives and Office documents are stored as they are,
  not compressed again.
- If the folder you zip is named like a Windows drive (`C:x`), the zip and the
  folder inside it are named `C_x`. Folders and files inside it keep their
  names.
- Dotfiles that are not protected, such as `.gitignore`, are included whether
  or not **Hidden files** is ticked.

A link on another site cannot make your browser download a file or a zip from
the app: such a request is refused.

In the Home Assistant Companion app, the app's web view may preview a download
instead of saving it. If a download does not save, open Home Assistant in a
browser and download it from there.

**Uploads.** Files go into `/config` from your device in these ways:

- **⬆️ Upload** in the sidebar's toolbar puts them in the inbox,
  `/config/uploads`, which is made the first time it is needed. A name that is
  taken there gets a number instead (`photo (1).jpg`).
- **Upload here** in a folder's **⋯** menu puts them in that folder. If a file
  of that name is already there, the sidebar asks: **Replace**, **Keep both**
  (the new one gets a number) or **Cancel** (Escape cancels too, while the question has focus).
  When the question takes focus, it is on **Keep both**, so Enter loses nothing. If you hide
  the sidebar while a question waits, a dot on the **🗂️** button (and on the rail) shows that
  one is waiting, and the upload waits for your answer; open the sidebar to answer it. Nothing is
  ever overwritten without that question. Replace swaps in the whole new file at once and keeps
  the old file's permissions, so a private key stays private; Replace is not
  offered when the name belongs to a folder or a link.
- **Dropping files** on a folder row means Upload here; dropping them anywhere
  else on the sidebar sends them to the inbox. Folders themselves cannot be
  dropped: drop the files inside them.
- **Pasting files** (Ctrl+V, or Cmd+V on a Mac) after you click a row in the
  sidebar, or move to something in it with Tab, follows the same rule, with
  the selected row in place of the row dropped on: with a folder selected,
  they go into that folder (Upload here); with a file or nothing selected, or
  the sidebar down to its rail, they go to the inbox. With a folder's **⋯**
  menu open, they go into that folder. A folder that is no upload target
  refuses them, as it refuses a drop. Nothing is typed into the terminal.
  Where focus is decides, not where text happens to be selected: in Safari,
  clicking a button other than a row does not move focus, so click the row.
  While a file's preview is open, a pasted file is refused: close the preview
  first. A clipboard that also holds plain text pastes that text instead, as
  in the terminal.
- **From the terminal**, 📎, a paste or a drop puts anything but a small
  image in the inbox and types its path at the prompt (see Uploading Files
  from the Terminal).

You can pick, drop or paste several files at once; they upload one after another, a
progress bar shows how far each has got, and a question about a taken name
comes up for each in turn. The question takes focus only if you are working
in the sidebar; if you are typing in the terminal, or have a preview open, it
waits in the sidebar and the notice asks you to answer there, so a keystroke
meant for the terminal never answers it. Once they are in, the last file is
shown in the tree. Its preview opens only if you are still in the sidebar, and
not when any file in the batch was refused. A sidebar upload types nothing
into the terminal. A file whose name marks it as protected (a certificate such as
`fullchain.pem`, say) is shown in the tree but not opened unless **Show
protected files** is on.

Any type of file can be uploaded, up to `upload_max_mb` (25 MB unless you
change it; at most 1024 MB); a bigger one is refused before any of it is
sent, and the message names the limit. Names are cleaned: folders in the
name, control characters, invisible text-direction marks (which can make a
name read backwards) and leading dots are taken out (`.env` arrives as
`env`), and a very long name is shortened. Names are stored in Unicode's
composed form (NFC), so an accented letter typed on one device and the same
letter in a name from a Mac are one name. A file already in the folder whose
name only looks the same (the same letters stored another way, copied in over
Samba, say) counts as taken: the question names that file, and Replace
overwrites it under its own name (in a folder of over 10,000 entries, only the
exact name is checked). New files can be read by everyone
and run by no one (`0644`). Certificates and keys can be uploaded like any
other file. `secrets.yaml` is an ordinary name; replacing one goes through the
same question. An upload has 30 minutes to arrive, or longer if you raise
`upload_max_mb` (enough for a file at the limit over a 128 kbit/s link), but
never more than 12 hours.

If the app has to refuse a write, the message says why: the file system is
read-only, the app is not allowed to write there, the name is too long for
the file system, or the disk is full. Uploads are limited in rate: when the
app answers "too many uploads", the batch stops at that file, and one line
says how many were not uploaded (or names the one). Wait a minute and pick
the rest again.

Some folders are never upload targets: protected ones (their **Upload here**
is disabled and says why), `deps` (Home Assistant's own Python packages),
`.git`, anything outside `/config`, and a symlinked folder, which has no
**Upload here** at all. Upload into the folder it points to instead. The
folders inside a symlinked folder are listed at their real location, and do
have **Upload here**.

**The inbox is disposable.** At every start, the app deletes each file at
the top level of `/config/uploads` that was last modified more than
`upload_retention_days` days ago (30 unless you change it; `0` keeps them
forever), whoever put it there, Claude included. Folders inside the inbox,
and anything in them, are left alone, as are symlinks at its top level, and
so is every folder you chose with **Upload here**, except `/config/uploads`
itself: Upload here on it puts files in the inbox, and its menu says that
files there are cleared after `upload_retention_days` if the app made the
folder (it holds `.ctp-inbox`, below). Keep files you want to last somewhere
else. If `/config/uploads` is a
symlink or a file rather than a folder, it is never swept, and uploads to the
inbox are refused until it is a plain folder again.

Only an inbox the app made is swept. When it makes `/config/uploads`, it
writes a one-line note into it, `.ctp-inbox`, which marks the folder as its
own; the sidebar never shows the note, nor puts it in a zip, and the sweep
never deletes it. If you already had a folder called `uploads` in `/config`,
uploads go into it as well, but nothing in it is ever deleted: the log says
at every start that it is not swept, and why (unless `upload_retention_days`
is `0`, when nothing is swept anyway). If the app cannot write the note,
the log says so, and that inbox is not swept either. To have such a folder
swept like an inbox the app made, create the marker yourself (`touch
/config/uploads/.ctp-inbox` in the terminal). To keep it as your own, move or
rename it, and the app makes a fresh inbox on the next upload. Deleting
`.ctp-inbox` stops the sweep in the same way; the marker must be a plain
file, not a symlink.

An unfinished upload never leaves a partial file: if the connection drops,
the browser stops sending, the disk fills up, or the app restarts mid-way,
what had arrived is deleted (at the next start, in the last case). A page on
another site cannot upload into your `/config`: such a request is refused.

#### Persistent Package Management
- **System packages**: Install APK packages that survive restarts
- **Python packages**: Install pip packages in persistent virtual environment
- **Auto-install**: Configure packages to install automatically on startup
- **Simple command**: Use `persist-install` for all package management
- **Claude commands and skill**: the app's `/install`, `/install-python` and `/list-packages` commands and its persistent-package skill are refreshed in `~/.claude` on every start, so an update reaches existing installs. Your own commands and skills are left alone; save a variant of a shipped one under a different name, or the next start replaces it
- **Storage location**: `/data/packages/` (permanent storage)

See [PERSISTENT_PACKAGES.md](PERSISTENT_PACKAGES.md) for complete guide.

#### Session Management
- **Interactive menu**: Choose between new, continue, or resume sessions
- **GitHub CLI**: Pre-installed with persistent authentication
- **tmux integration**: Sessions persist across browser refreshes
- **Your own tmux settings**: put them in `~/.tmux.local.conf`. `~/.tmux.conf` is rewritten from the app on every start (it carries the mouse and clipboard setup), and it sources `~/.tmux.local.conf` last, so your settings win and survive restarts
- **Key buttons**: the header's `^C`, `Tab`, `⇧Tab`, `Esc`, arrow and `Enter` buttons send those keys, for phones and tablets without a keyboard. `⇧Tab` (Shift+Tab) is the one Claude uses to switch permission mode
- **Mouse and selection**: mouse reporting is on by default, so the wheel (and a touch swipe) always scrolls something sensible. Inside a full-screen program that wants the mouse - Claude Code, vim, htop - the wheel scrolls *that program's* view, the same content `PgUp`/`PgDn` moves through. At a shell prompt, where nothing has claimed the mouse, it scrolls tmux history instead. Nothing detects which program is running; tmux routes the wheel to whoever asked for it
  - **Drag to select**: a plain drag selects in tmux and copies to your clipboard automatically when you release
  - **Shift+drag** (**Option+drag** on macOS) selects using the terminal's own selection instead, which reaches into the full scrollback and also copies automatically. Use it when a full-screen app wants the mouse for itself
  - Turn reporting off with the `tmux_mouse_mode` option, or live with **Prefix + m**. With it off the wheel sends arrow keys to full-screen apps; scroll with `Ctrl+B, [`
- **New line without sending**: **Shift+Enter** inserts a line break in Claude's prompt. The terminal sends `\` + Enter for it, which Claude Code reads as a newline (and a shell as a line continuation). Claude's `/terminal-setup` is not needed and cannot configure this browser terminal
- **Clipboard (OSC 52)**: tmux runs with `set-clipboard on`, so any process on the terminal can place text on your system clipboard. This was always the intent of that setting, but the sequence was inert until the wrapper gained a handler — it is now live. Every such copy flashes the clipboard button in the header and leaves an unread dot on it, so a copy that arrives while you are reading the terminal is still there when you look up. Clicking the button places the text on your browser clipboard and clears the dot. Clipboard *read* requests are refused, so no process can exfiltrate your clipboard through the terminal
  - **Over the direct `:7680` port, the click is required.** Browsers only expose the clipboard API on a secure origin, so on plain HTTP the copy is held until you click the clipboard button. Through Home Assistant ingress (HTTPS) it lands automatically and the button is just a notification. Selecting text with the mouse is unaffected either way — that path copies through the terminal itself, not the clipboard API

## Troubleshooting

- Run `claude-doctor` in the terminal first — it reports the environment faults
  behind most failures, including the two that look like a hang rather than an
  error: a CPU without AVX (common on Proxmox/QEMU VMs using the default `kvm64`
  CPU type) and a Claude binary that is installed but aborts on launch
- If Claude doesn't start automatically, try running `claude` manually
- If you see permission errors, try restarting the app
- If you have authentication issues, try logging out and back in
- Check the app logs for any error messages

## Credits

**Original Creator:** Tom Cassady ([@heytcass](https://github.com/heytcass))
**Fork Maintainer:** Javier Santos ([@esjavadex](https://github.com/esjavadex))

This app was created and enhanced with the assistance of Claude Code itself! The development process, debugging, and documentation were all completed using Claude's AI capabilities - a perfect demonstration of what this app can help you accomplish.