# Test Configuration Directory

This directory contains example configuration files for local development and testing.

## Purpose

When testing the add-on locally with Docker/Podman, this directory can be mounted as `/config` to provide test configurations without affecting your production Home Assistant instance.

## Files

- **options.json** - Example add-on configuration
  - Used for testing different add-on settings locally
  - Not used in production (Home Assistant Supervisor provides options at runtime)

- **claude-config/** - Placeholder for Claude authentication
  - Demonstrates credential persistence structure
  - In production, mounted from `/data/config/claude-config/`

## Usage

```bash
# Mount this directory when testing locally
docker run -p 7681:7681 \
  -v $(pwd)/config:/config \
  local/claude-terminal:test

# Or with Podman
podman run -p 7681:7681 \
  -v $(pwd)/config:/config \
  local/claude-terminal:test
```

## Note

**This is a development fixture directory.** In production Home Assistant installations:
- Configuration comes from the add-on's UI settings
- Credentials are stored in `/data/.config/claude/`
- This directory is NOT used

See [CLAUDE.md](../CLAUDE.md#local-container-testing) for complete local testing instructions.
