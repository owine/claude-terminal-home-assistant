#!/usr/bin/with-contenv bashio
# Setup ha-mcp (Home Assistant MCP Server) for Claude Code
# This script configures Claude Code to use ha-mcp for Home Assistant integration
# Repository: https://github.com/homeassistant-ai/ha-mcp

set -e

# ha-mcp is pre-installed at build time via uv sync --locked
HA_MCP_BIN="/opt/ha-mcp/.venv/bin/ha-mcp"

# Check if ha-mcp setup should be enabled
configure_ha_mcp_server() {
    local enable_ha_mcp
    enable_ha_mcp=$(bashio::config 'enable_ha_mcp' 'true')

    if [ "$enable_ha_mcp" != "true" ]; then
        bashio::log.info "ha-mcp integration is disabled in configuration"
        return 0
    fi

    bashio::log.info "Setting up ha-mcp (Home Assistant MCP Server)..."

    # Check for supervisor token (required for HA API access)
    if [ -z "${SUPERVISOR_TOKEN:-}" ]; then
        bashio::log.warning "SUPERVISOR_TOKEN not available - ha-mcp setup skipped"
        bashio::log.warning "MCP server requires Supervisor API access"
        return 0
    fi

    # Verify pre-installed ha-mcp binary exists
    if [ ! -x "$HA_MCP_BIN" ]; then
        bashio::log.warning "ha-mcp binary not found at ${HA_MCP_BIN} - setup skipped"
        bashio::log.warning "This may indicate a build issue. Try reinstalling the add-on."
        return 0
    fi

    # Configure Claude Code to use ha-mcp
    # The MCP server will connect to Home Assistant via the Supervisor API
    bashio::log.info "Configuring Claude Code MCP server for Home Assistant..."

    # Remove existing ha-mcp configuration if present (to ensure clean state)
    claude mcp remove home-assistant 2>/dev/null || true

    # Add ha-mcp as MCP server using pre-installed binary
    # Environment variables:
    #   HOMEASSISTANT_URL: Internal Supervisor API endpoint
    #   HOMEASSISTANT_TOKEN: Supervisor token for authentication
    # ENABLE_SKILLS: Serve bundled HA best-practice skills as MCP resources (skill:// URIs)
    # ENABLE_SKILLS_AS_TOOLS: Also expose skills as tools for broader client compatibility
    if claude mcp add home-assistant \
        --env "HOMEASSISTANT_URL=http://supervisor/core" \
        --env "HOMEASSISTANT_TOKEN=${SUPERVISOR_TOKEN}" \
        --env "ENABLE_SKILLS=true" \
        --env "ENABLE_SKILLS_AS_TOOLS=true" \
        -- "$HA_MCP_BIN"; then
        bashio::log.info "ha-mcp configured successfully!"
        bashio::log.info "Claude Code now has access to Home Assistant via MCP"
        bashio::log.info "Available tools: entity control, automations, scripts, history, and more"
    else
        bashio::log.warning "Failed to configure ha-mcp - continuing without MCP integration"
        bashio::log.warning "You can manually run: claude mcp add home-assistant --env HOMEASSISTANT_URL=http://supervisor/core --env HOMEASSISTANT_TOKEN=\$SUPERVISOR_TOKEN -- ${HA_MCP_BIN}"
    fi
}

# Run setup if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    configure_ha_mcp_server
fi
