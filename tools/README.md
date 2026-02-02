# Development Tools

This directory contains development-specific tools and utilities that are not part of the core add-on.

## Mac Clipboard Monitor

**File:** `mac-clipboard-monitor.py`

A macOS development tool that automatically uploads images from your Mac clipboard to Claude Terminal running on your Home Assistant instance.

### Purpose

Enables a seamless workflow for Mac users during development:
1. Take a screenshot or copy an image on your Mac
2. Tool automatically detects the image in clipboard
3. Uploads to your Home Assistant Claude Terminal instance
4. You can immediately paste and discuss the image with Claude

### Requirements

- macOS (uses `pboard` for clipboard monitoring)
- Python 3.7+
- Network access to Home Assistant instance

### Usage

See [MAC_CLIPBOARD_MONITOR.md](./MAC_CLIPBOARD_MONITOR.md) for complete setup and usage instructions.

### Note

This is a **personal development tool** for the repository maintainer's workflow. It is not required for:
- Using the Claude Terminal add-on
- Contributing to the repository
- Running the add-on in production

If you find it useful, feel free to adapt it for your own workflow!
