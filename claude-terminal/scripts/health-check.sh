#!/usr/bin/with-contenv bashio

# Health check script for Claude Terminal app
# Validates environment and provides diagnostic information

check_system_resources() {
    bashio::log.info "=== System Resources Check ==="

    # Check available memory
    local mem_total
    mem_total=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    local mem_free
    mem_free=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
    bashio::log.info "Memory: ${mem_free}MB free of ${mem_total}MB total"

    if [ "$mem_free" -lt 256 ]; then
        bashio::log.error "Low memory warning: Less than 256MB available"
        bashio::log.info "This may cause installation or runtime issues"
    fi

    # Check disk space in /data
    local disk_free
    disk_free=$(df -m /data | tail -1 | awk '{print $4}')
    bashio::log.info "Disk space in /data: ${disk_free}MB free"

    if [ "$disk_free" -lt 100 ]; then
        bashio::log.error "Low disk space warning: Less than 100MB in /data"
    fi
}

check_cpu_capabilities() {
    bashio::log.info "=== CPU Capability Check ==="

    # Claude Code ships as a Bun-compiled native binary, and Bun requires AVX
    # on x86-64. Hypervisor default CPU types (Proxmox/QEMU kvm64, qemu64)
    # mask AVX even when the physical CPU has it, and every claude invocation
    # then spins at 100% CPU with no output or dies with SIGILL. The binary is
    # still present and executable, so check_claude_cli passes and the failure
    # looks like a hang rather than an unsupported CPU. Not applicable on
    # aarch64.
    local arch
    arch=$(uname -m)

    if [ "$arch" != "x86_64" ]; then
        bashio::log.info "Architecture ${arch}: AVX check not applicable ✓"
        return 0
    fi

    if grep -qw avx /proc/cpuinfo; then
        bashio::log.info "CPU exposes AVX ✓"
        return 0
    fi

    bashio::log.error "CPU does not expose AVX ✗"
    bashio::log.info "Claude Code's runtime (Bun) requires AVX; without it every"
    bashio::log.info "claude invocation hangs at 100% CPU or crashes with SIGILL."
    bashio::log.info "On a VM this usually means the hypervisor hides the host CPU:"
    bashio::log.info "  • Proxmox/QEMU: set the VM's CPU type to 'host' (not kvm64/qemu64),"
    bashio::log.info "    then fully shut the VM down and start it again - a reboot"
    bashio::log.info "    is not enough to pick up the new CPU model"
    bashio::log.info "  • Other hypervisors: enable host CPU passthrough"
    return 1
}

check_directory_permissions() {
    bashio::log.info "=== Directory Permissions Check ==="

    # Check if /data is writable
    if [ -w "/data" ]; then
        bashio::log.info "/data directory: Writable ✓"
    else
        bashio::log.error "/data directory: Not writable ✗"
        return 1
    fi

    # Try to create test directory
    local test_dir="/data/.test_$$"
    if mkdir -p "$test_dir" 2>/dev/null; then
        bashio::log.info "Can create directories in /data ✓"
        rmdir "$test_dir"
    else
        bashio::log.error "Cannot create directories in /data ✗"
        return 1
    fi
}

check_node_installation() {
    bashio::log.info "=== Node.js Installation Check ==="

    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node --version)
        bashio::log.info "Node.js installed: $node_version ✓"
    else
        bashio::log.error "Node.js not found ✗"
        return 1
    fi

    if command -v npm >/dev/null 2>&1; then
        local npm_version
        npm_version=$(npm --version)
        bashio::log.info "npm installed: $npm_version ✓"
    else
        bashio::log.error "npm not found ✗"
        return 1
    fi
}

check_claude_cli() {
    bashio::log.info "=== Claude CLI Check ==="

    # Check known install locations directly — do not rely on PATH here because
    # with-contenv resets PATH to the s6 container environment, which does not
    # include /data/home/.local/bin (set at runtime by run.sh, not at build time).
    local claude_bin=""
    for candidate in /root/.local/bin/claude /data/home/.local/bin/claude; do
        if [ -x "$candidate" ]; then
            claude_bin="$candidate"
            break
        fi
    done

    if [ -n "$claude_bin" ]; then
        bashio::log.info "Claude CLI found at: $claude_bin ✓"
    else
        bashio::log.error "Claude CLI not found ✗"
        return 1
    fi
}

run_diagnostics() {
    bashio::log.info "========================================="
    bashio::log.info "Claude Terminal App Health Check"
    bashio::log.info "========================================="

    local errors=0

    check_system_resources || ((errors++))
    check_cpu_capabilities || ((errors++))
    check_directory_permissions || ((errors++))
    check_node_installation || ((errors++))
    check_claude_cli || ((errors++))

    bashio::log.info "========================================="

    if [ "$errors" -eq 0 ]; then
        bashio::log.info "✅ All checks passed successfully!"
    else
        bashio::log.error "❌ $errors check(s) failed"
        bashio::log.info "Please review the errors above"
    fi

    return $errors
}

# Run if executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    run_diagnostics
fi
