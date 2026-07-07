---
name: persistent-package-manager
description: |
  Install and manage packages that persist across container restarts in Home Assistant add-ons.
  Use this skill when users ask to install system packages (git, vim, python3) or Python packages
  (homeassistant-cli, requests, pandas). Automatically uses persist-install instead of apk/pip
  to ensure packages survive reboots and container recreations.
---

# Persistent Package Manager Skill

## Purpose

This skill governs **how you behave** when a user in the Claude Terminal Home
Assistant add-on needs a package installed. Its job is to make sure packages
**persist across container restarts and reboots**. You must NEVER use `apk add`
or `pip install` directly — those write to ephemeral storage that disappears on
restart.

> **Reference material lives in one place.** The complete command table, storage
> paths, auto-install configuration, common-package lists, and troubleshooting
> steps are maintained in
> [`PERSISTENT_PACKAGES.md`](../../../PERSISTENT_PACKAGES.md) (the human-facing
> guide). This skill intentionally does **not** duplicate those tables — consult
> that guide for exact syntax and edge cases, and keep this file focused on
> *when and how you should act*.

## Core Concept: Container Architecture

```
┌─────────────────────────────────────────┐
│  Container Filesystem (EPHEMERAL)      │
│  - Base image packages (node, npm)     │
│  - apk add installs HERE (LOST!)       │
│  ❌ Disappears on reboot               │
└─────────────────────────────────────────┘
              ↕
┌─────────────────────────────────────────┐
│  /data/packages (PERSISTENT)           │
│  - persist-install installs HERE       │
│  - Survives reboots & updates          │
│  ✅ Permanent storage                  │
└─────────────────────────────────────────┘
```

## When to Use This Skill

Activate this skill when users:
- Ask to install any package: "install python", "I need git", "add vim"
- Want to use a tool that isn't installed: "can we use pandas?"
- Encounter "command not found" errors
- Ask about package management or persistence
- Want to set up a development environment

## The Golden Rule

**ALWAYS use `persist-install` - NEVER use `apk add` or `pip install` directly!**

## Commands You Will Use

`persist-install` is the single entry point. You only need these three modes;
see `PERSISTENT_PACKAGES.md` for the full table, aliases, and options.

| Mode | Command | Use when the user wants... |
|------|---------|----------------------------|
| System package | `persist-install <pkg>...` | An Alpine/APK tool: git, vim, htop, python3 |
| Python package | `persist-install --python <pkg>...` | A pip/PyPI package: requests, pandas, homeassistant-cli |
| List | `persist-install --list` | To see what's installed |

## Your Workflow When User Asks to Install

### Step 1: Recognize Intent

User phrases like:
- "install X"
- "I need X"
- "can you add X?"
- "let's use X"
- "how do I get X?"
- "bash: X: command not found"

### Step 2: Check If Already Installed (Optional but Recommended)

```bash
which <package>
# or
command -v <package>
# or
<package> --version
```

### Step 3: Use persist-install

**For system packages**:
```bash
persist-install <package>
```

**For Python packages**:
```bash
# Ensure Python is installed first!
python3 --version || persist-install python3 py3-pip

# Then install Python package
persist-install --python <package>
```

### Step 4: Verify Installation

```bash
<package> --version
# or
which <package>
# or for Python packages
python3 -c "import <package>"
```

### Step 5: Explain to User

Tell them:
- ✅ Package installed successfully
- ✅ Stored in `/data/packages` (persistent storage)
- ✅ Will survive reboots and container restarts
- ✅ Available in PATH immediately

## Example Conversations

### Example 1: Installing Python

```
User: "I need Python installed"

You: "I'll install Python using persist-install so it survives reboots."

[Execute]: persist-install python3 py3-pip

[Verify]: python3 --version

You: "Python 3.x installed successfully! It's stored in /data/packages
     and will persist across all restarts. You can now install Python
     packages with: persist-install --python <package>"
```

### Example 2: Data Science Setup

```
User: "Set me up for data science work"

You: "I'll set up a complete data science environment with persistent packages."

[Execute]: persist-install python3 py3-pip
[Execute]: persist-install --python pandas numpy scipy matplotlib jupyter

[Verify]: python3 -c "import pandas; import numpy; print('All packages ready!')"

You: "Data science environment ready! Installed:
     - Python 3.x
     - pandas - Data analysis
     - numpy - Numerical computing
     - scipy - Scientific computing
     - matplotlib - Plotting
     - jupyter - Interactive notebooks

     All packages are persistent and will survive reboots."
```

### Example 3: Development Tools

```
User: "I want git and vim"

You: "I'll install git and vim using persist-install."

[Execute]: persist-install git vim

[Verify]:
git --version
vim --version

You: "Development tools installed:
     - Git 2.x - Version control
     - Vim 9.x - Text editor

     Both are persistent and available in PATH."
```

## Auto-Install Configuration (behavioral note)

When users want packages installed automatically on every startup, point them at
the **Home Assistant UI**: **Settings → Apps → Claude Terminal → Configuration**,
then add entries under `persistent_apk_packages` / `persistent_pip_packages` and
Save + Restart. The add-on reads these from `/data/options.json`, which the
Supervisor manages — do not tell users to hand-edit it. Full details and a config
example are in `PERSISTENT_PACKAGES.md`.

## Troubleshooting (behavioral note)

If a freshly installed package isn't found, confirm it landed in
`/data/packages/bin` (or the venv) and that `/data/packages` is on `PATH`, then
re-run `persist-install`. The complete troubleshooting playbook (PATH checks,
Python import errors, shared-library issues, clean slate) is in
`PERSISTENT_PACKAGES.md` — refer users there rather than restating it.

## Important Reminders

1. **NEVER use `apk add`** for user-requested packages - Always `persist-install`
2. **NEVER use `pip install`** directly - Always `persist-install --python`
3. **ALWAYS verify** after installation with `--version` or test command
4. **ALWAYS explain** that packages will persist across reboots
5. **BE PROACTIVE** - Install packages when you detect the need
6. **CHECK FIRST** - See if package is already installed before installing

## What NOT to Do

❌ **DON'T** use `apk add python3` - Use `persist-install python3`
❌ **DON'T** use `pip install requests` - Use `persist-install --python requests`
❌ **DON'T** forget to verify installation
❌ **DON'T** install packages to system paths
❌ **DON'T** assume packages will persist without using persist-install

## Best Practices

✅ **DO** check if package is already installed first
✅ **DO** use persist-install for all user-requested packages
✅ **DO** verify installation after installing
✅ **DO** explain persistence to users
✅ **DO** suggest auto-install config for frequently used packages
✅ **DO** batch install related packages together

## Quick Reference

| User Says | You Do | Command |
|-----------|--------|---------|
| "install python" | Install Python | `persist-install python3 py3-pip` |
| "I need git" | Install git | `persist-install git` |
| "install pandas" | Install Python package | `persist-install --python pandas` |
| "what's installed?" | List packages | `persist-install --list` |
| "install git vim htop" | Install multiple | `persist-install git vim htop` |

## Summary

When users ask to install anything:
1. ✅ Use `persist-install` (NOT apk/pip)
2. ✅ Pick the right mode (system / `--python`)
3. ✅ Verify it works
4. ✅ Explain it persists
5. ✅ Suggest auto-install if appropriate

For any exact syntax, paths, or troubleshooting detail, consult
`PERSISTENT_PACKAGES.md` — the single source of truth for reference material.
