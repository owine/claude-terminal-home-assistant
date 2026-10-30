# Persistent Package Management Guide

## 🎯 Problem Solved

**Before**: Installing packages with `apk add` in the terminal disappeared after reboot
**After**: Use `persist-install` to install packages that survive forever!

---

## 🚀 Quick Start

### Install System Packages
```bash
# Install Python
persist-install python3 py3-pip

# Install development tools
persist-install git vim htop

# Install multiple packages at once
persist-install curl wget jq sqlite
```

### Install Python Packages
```bash
# Install a Python package (e.g. the hass-cli client)
persist-install --python homeassistant-cli

# Install data science tools
persist-install --python pandas numpy requests

# Install web frameworks
persist-install --python flask fastapi
```

### Check What's Installed
```bash
persist-install --list
```

---

## 🧰 Command Reference

`persist-install` is the single entry point. Every flag has short and word
aliases (e.g. `--python`, `-p`, and `python` all work).

| Command | Aliases | What it does |
|---------|---------|--------------|
| `persist-install <pkg> [pkg...]` | — | Install Alpine **APK system packages** and record them in `/data/packages/world`, so they are reinstalled on every start. A version spec (`curl=8.1-r0`, `curl>8`) is recorded as typed |
| `persist-install --remove <pkg> [pkg...]` | — | Stop reinstalling them on start. They stay installed until the app restarts (`apk del` removes them now) |
| `persist-install --python <pkg> [pkg...]` | `-p`, `python` | Install **Python packages** with pip into the persistent venv (`/data/packages/python/venv`) |
| `persist-install --list` | `-l`, `list` | List recorded system packages, Python packages, and the size of apk's cache |
| `persist-install --help` | `-h`, `help` | Show usage help (also shown when run with no arguments) |

---

## 📋 How It Works

### The Persistent Storage Model

```
┌─────────────────────────────────────────────┐
│  Container Filesystem (EPHEMERAL)          │
│  - Base image packages (node, npm, bash)   │
│  - Rebuilt from the image on every start   │
│  ❌ apk add python3 → LOST on reboot      │
└─────────────────────────────────────────────┘
                    ↑  reinstalled by apk on every start
┌─────────────────────────────────────────────┐
│  /data/packages (PERSISTENT)               │
│  - world: the packages you asked for       │
│  - apk-cache: what apk downloaded          │
│  ✅ persist-install python3 → PERMANENT    │
└─────────────────────────────────────────────┘
```

`persist-install` keeps the *inputs* of an installation rather than its files:
the list of packages you asked for, and apk's download cache. At every start
the app replays that list through `apk add`, which produces a complete
installation each time: the package's data files, its dependencies, symlinks
and install scripts included. With the cache warm the replay takes seconds and
needs no network. A package that has never been downloaded on this install
(the first start after a backup restore, which leaves the cache out) needs the
network once.

### Directory Structure

```
/data/packages/
├── world             # Packages to reinstall on every start, one per line
├── apk-cache/        # apk's downloads and package indexes (not in backups)
└── python/           # Python virtual environment
    └── venv/
        ├── bin/
        │   ├── python
        │   ├── pip
        │   └── hass-cli
        └── lib/
            └── python3.*/site-packages/
```

System packages land where apk always puts them (`/usr/bin`, `/usr/lib`, ...),
so they need nothing special on `PATH`. At startup `run.sh` exports:

```bash
export PATH="/data/packages/python/venv/bin:$HOME/.local/bin:$PATH:/data/packages/bin"
```

### Upgrading from copied packages

Earlier versions of `persist-install` copied a package's binaries, shared libraries
and libexec helpers into `/data/packages/bin`, `lib` and `libexec`. Anything
else the package needed was lost on restart: python3 came back without its
standard library, and a package's dependencies were never kept.

On the first start after upgrading, the app looks up which package provides
each binary in `/data/packages/bin`, installs it properly and records it, then
logs any binary it could not match to exactly one package (`docker`, for
instance, is provided by both `docker-cli` and `podman-docker`). The old copies
stay, at the **end** of `PATH`, so they only fill gaps; their libraries are no
longer put on `LD_LIBRARY_PATH`, where a stale copy would override the system's
own. Once `persist-install --list` shows what you need, delete them:

```bash
rm -rf /data/packages/bin /data/packages/lib /data/packages/libexec
```

---

## 🔧 Configuration: Auto-Install on Startup

You can configure packages to install automatically every time the app starts.

### Via Home Assistant UI

1. Go to **Settings** → **Apps** → **Claude Terminal**
2. Click **Configuration** tab
3. Add your packages:

```yaml
persistent_apk_packages:
  - python3
  - py3-pip
  - git
  - vim
  - htop

persistent_pip_packages:
  - homeassistant-cli
  - requests
  - pyyaml
```

4. **Save** and **Restart** the app

### Via config file (Advanced)

The app reads its options from `/data/options.json`. This file is **normally
managed by the Home Assistant UI options** (the Configuration tab above) — the
Supervisor regenerates it whenever you Save, so hand-editing is rarely needed and
manual changes can be overwritten. Prefer the UI; inspect `/data/options.json`
only to confirm what the app actually received:

```json
{
  "auto_launch_claude": true,
  "persistent_apk_packages": [
    "python3",
    "py3-pip",
    "git",
    "vim",
    "htop"
  ],
  "persistent_pip_packages": [
    "homeassistant-cli",
    "requests",
    "pyyaml"
  ]
}
```

---

## 📚 Examples

### Example 1: Python Development Environment

```bash
# Install Python and essential tools
persist-install python3 py3-pip

# Install development libraries
persist-install --python ipython black pytest

# Install Home Assistant integration
persist-install --python homeassistant-cli

# Verify installation
python3 --version
pip --version
hass-cli --version

# Reboot your Raspberry Pi - everything still works!
```

### Example 2: Git Workflow

```bash
# Install Git
persist-install git

# Configure Git (persists in /data)
git config --global user.name "Your Name"
git config --global user.email "you@example.com"

# Clone repositories
cd /config
git clone https://github.com/yourusername/your-repo.git
```

### Example 3: System Administration Tools

```bash
# Install monitoring tools
persist-install htop iotop ncdu

# Install network tools
persist-install curl wget netcat-openbsd

# Install text processing
persist-install jq sed gawk

# Use them immediately
htop        # Process monitor
ncdu /      # Disk usage analyzer
```

### Example 4: Home Assistant Automation

```bash
# Install HA CLI and Python tools
persist-install python3 py3-pip
persist-install --python homeassistant-cli pyyaml

# Use HA CLI (requires HA API access)
hass-cli entity list
hass-cli state get sensor.temperature
hass-cli service call light.turn_on --arguments entity_id=light.living_room
```

---

## 🧪 Testing Persistence

### Verify packages survive reboots:

```bash
# 1. Install a package
persist-install python3
python3 --version

# 2. Check it's recorded
persist-install --list

# 3. Reboot your Raspberry Pi
# (or restart the app)

# 4. Verify it still works
python3 --version  # ✅ Still there!
```

---

## 🔍 Troubleshooting

### Package not found after a restart

```bash
# Is it recorded?
persist-install --list

# Restore the recorded packages now (the app does this at every start)
persist-install --restore
```

The app log shows the restore at startup. A package that could not be
restored (no network, and not yet in apk's cache) is named there.

### Python package import errors

```bash
# Activate the virtual environment
source /data/packages/python/venv/bin/activate

# Check installed packages
pip list

# Reinstall if needed
persist-install --python package-name
```

### Clean slate (remove all packages)

```bash
# Forget every recorded package and apk's cache (the Python venv stays)
rm -rf /data/packages/world /data/packages/apk-cache

# Restart app to rebuild structure
```

---

## 💡 Best Practices

### ✅ DO

- Use `persist-install` for packages you need regularly
- Configure auto-install for your essential toolkit
- Use Python virtual environment for Python packages
- Test packages before adding to auto-install
- Keep packages list minimal to reduce startup time

### ❌ DON'T

- Don't use `apk add` directly (packages will disappear)
- Don't install huge packages (database servers, etc.)
- Don't edit `/data/packages/world` by hand while `persist-install` runs (use `--remove`)

---

## 🎓 Advanced Usage

### Using the Python Virtual Environment

```bash
# Activate venv manually
source /data/packages/python/venv/bin/activate

# Install with pip directly
pip install your-package

# Deactivate
deactivate
```

### Creating Custom Scripts

```bash
# Create a script in your persistent home, which is on PATH
cat > ~/.local/bin/my-script.sh << 'EOF'
#!/bin/bash
echo "This script persists!"
EOF

chmod +x ~/.local/bin/my-script.sh

# Run it (it's in PATH)
my-script.sh
```

### Checking Disk Usage

```bash
# See how much space packages use
du -sh /data/packages

# Detailed breakdown
du -sh /data/packages/*
```

---

## 🆚 Comparison

| Method | Survives Reboot? | Survives Update? | Speed | Flexibility |
|--------|------------------|------------------|-------|-------------|
| `apk add` (directly in the terminal) | ❌ No | ❌ No | Fast | High |
| Baking into the Dockerfile | ✅ Yes | ✅ Yes | Slow rebuild | Low |
| `persist-install` | ✅ Yes | ✅ Yes | Seconds per start (cached) | High |

---

## 📖 Further Reading

- [Home Assistant App Documentation](https://developers.home-assistant.io/docs/add-ons/)
- [Alpine Linux Packages](https://pkgs.alpinelinux.org/)
- [Python Package Index (PyPI)](https://pypi.org/)
- [Docker Volume Documentation](https://docs.docker.com/storage/volumes/)

---

## 🐳 Docker CLI (via `enable_docker`)

Enabling the `enable_docker` app option installs `docker-cli` and `docker-cli-compose` at every start, through `persist-install`'s apk cache, so the tools survive container restarts without any manual steps. They are not added to your recorded list: turn the option off and they are no longer installed.

If `enable_docker_buildx: true` is also set, `docker-cli-buildx` is installed in the same way, adding `docker buildx` support for image builds.

**Important:** installing the CLI tools alone is not enough to use Docker. The host Docker socket (`/run/docker.sock`) is only mounted into the container when **Protection Mode is disabled** in the app's **Info** tab. While Protection Mode is on (the default), the socket is never available, and `docker` commands will fail with a daemon connection error.

Like all packages installed via `persist-install`, the Docker CLI version floats to whatever Alpine's package repos currently provide — it is not version-pinned and is not tracked by Renovate.

---

## 🐛 Known Limitations

1. **Network on a cold cache**: a package apk has not downloaded on this install (the first start after a backup restore, for instance) needs the network to come back
2. **Compiled binaries**: Architecture-specific binaries may fail on different platforms
3. **Kernel modules**: Cannot install kernel-level packages
4. **System services**: Cannot run systemd/init services
5. **Storage space**: Limited by Home Assistant's available disk space

---

## 💬 Support

If you encounter issues:

1. Check the app logs: **Settings** → **Apps** → **Claude Terminal** → **Log**
2. Run `persist-install --list` to verify installations
3. Report issues on GitHub with log output
4. Include your package list and error messages
