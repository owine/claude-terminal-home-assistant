# Home Assistant base image (provided by Home Assistant Builder via build.yaml)
# For local testing, pass --build-arg BUILD_FROM=ghcr.io/home-assistant/{arch}-base:3.23
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23
# renovate: ignore - base image version managed via build.yaml
FROM ${BUILD_FROM}

# Upgrade base packages for security patches, then install dependencies in one layer
# Node.js and npm kept for wrapper service dependency
RUN apk upgrade --no-cache \
    && apk add --no-cache \
    bash \
    curl \
    git \
    jq \
    nano \
    nodejs \
    npm \
    py3-aiohttp \
    py3-beautifulsoup4 \
    py3-pip \
    py3-requests \
    py3-yaml \
    python3 \
    tmux \
    tree \
    ttyd \
    vim \
    wget \
    yq

# Install Claude Code CLI with version pinning and integrity checking
# Downloads specific version with SHA256 verification from manifest
# renovate: datasource=custom.claude-code
ARG CLAUDE_VERSION=2.1.81
RUN set -eux; \
    # Detect platform for Alpine Linux (musl-based)
    case "$(uname -m)" in \
        x86_64)  PLATFORM="linux-x64-musl" ;; \
        aarch64) PLATFORM="linux-arm64-musl" ;; \
        *)       echo "Unsupported architecture: $(uname -m)" && exit 1 ;; \
    esac; \
    \
    # Base URL for Claude Code distribution
    BASE_URL="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"; \
    \
    # Download and parse manifest for SHA256 checksum
    echo "Fetching Claude Code v${CLAUDE_VERSION} manifest..."; \
    MANIFEST=$(curl -fsSL "${BASE_URL}/${CLAUDE_VERSION}/manifest.json"); \
    EXPECTED_SHA=$(echo "$MANIFEST" | jq -r ".platforms.\"${PLATFORM}\".checksum"); \
    \
    # Validate checksum format
    if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" = "null" ]; then \
        echo "ERROR: No checksum found for platform ${PLATFORM} in manifest"; \
        exit 1; \
    fi; \
    \
    # Download Claude Code binary
    echo "Downloading Claude Code v${CLAUDE_VERSION} for ${PLATFORM}..."; \
    curl -fsSL "${BASE_URL}/${CLAUDE_VERSION}/${PLATFORM}/claude" -o /tmp/claude; \
    \
    # Verify SHA256 checksum
    echo "Verifying binary integrity..."; \
    ACTUAL_SHA=$(sha256sum /tmp/claude | cut -d' ' -f1); \
    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then \
        echo "ERROR: SHA256 mismatch!"; \
        echo "Expected: $EXPECTED_SHA"; \
        echo "Got:      $ACTUAL_SHA"; \
        rm -f /tmp/claude; \
        exit 1; \
    fi; \
    \
    # Install verified binary to /root/.local/bin (native binary location)
    echo "Installing Claude Code v${CLAUDE_VERSION}..."; \
    mkdir -p /root/.local/bin; \
    mv /tmp/claude /root/.local/bin/claude; \
    chmod +x /root/.local/bin/claude; \
    \
    # Verify installation (PATH will include /root/.local/bin at runtime)
    /root/.local/bin/claude --version

# Install uv for running ha-mcp (Python package manager/runner) with SHA256 verification
# ha-mcp requires Python 3.13+, uv handles this automatically
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=0.11.2
RUN set -eux; \
    # Detect platform for Alpine Linux (musl-based)
    case "$(uname -m)" in \
        x86_64)  PLATFORM="x86_64-unknown-linux-musl" ;; \
        aarch64) PLATFORM="aarch64-unknown-linux-musl" ;; \
        *)       echo "Unsupported architecture: $(uname -m)" && exit 1 ;; \
    esac; \
    \
    # Base URL for uv releases
    BASE_URL="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}"; \
    TARBALL="uv-${PLATFORM}.tar.gz"; \
    \
    # Download checksum file for this specific platform
    echo "Fetching uv v${UV_VERSION} checksum for ${PLATFORM}..."; \
    curl -fsSL "${BASE_URL}/${TARBALL}.sha256" -o /tmp/uv.sha256; \
    \
    # Extract expected checksum (format: "checksum  filename")
    EXPECTED_SHA=$(cat /tmp/uv.sha256 | awk '{print $1}'); \
    \
    # Validate checksum format
    if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" = "null" ]; then \
        echo "ERROR: No checksum found for ${TARBALL}"; \
        exit 1; \
    fi; \
    \
    # Download uv tarball
    echo "Downloading uv v${UV_VERSION} for ${PLATFORM}..."; \
    curl -fsSL "${BASE_URL}/${TARBALL}" -o /tmp/uv.tar.gz; \
    \
    # Verify SHA256 checksum
    echo "Verifying binary integrity..."; \
    ACTUAL_SHA=$(sha256sum /tmp/uv.tar.gz | awk '{print $1}'); \
    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then \
        echo "ERROR: SHA256 mismatch!"; \
        echo "Expected: $EXPECTED_SHA"; \
        echo "Got:      $ACTUAL_SHA"; \
        rm -f /tmp/uv*; \
        exit 1; \
    fi; \
    \
    # Install verified binary
    echo "Installing uv v${UV_VERSION}..."; \
    mkdir -p /root/.local/bin; \
    tar -xzf /tmp/uv.tar.gz -C /tmp; \
    mv /tmp/uv-${PLATFORM}/uv /root/.local/bin/uv; \
    mv /tmp/uv-${PLATFORM}/uvx /root/.local/bin/uvx; \
    chmod +x /root/.local/bin/uv /root/.local/bin/uvx; \
    ln -sf /root/.local/bin/uv /usr/local/bin/uv; \
    ln -sf /root/.local/bin/uvx /usr/local/bin/uvx; \
    rm -rf /tmp/uv*; \
    \
    # Verify installation
    /usr/local/bin/uv --version

# Install Home Assistant CLI (ha command)
# Download appropriate binary based on build architecture
# renovate: datasource=github-releases depName=home-assistant/cli
ARG HA_CLI_VERSION=5.0.0
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
        amd64)   HA_ARCH="amd64" ;; \
        arm64)   HA_ARCH="aarch64" ;; \
        *)       echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    echo "Installing Home Assistant CLI ${HA_CLI_VERSION} for ${HA_ARCH}..." && \
    curl -fsSL -o /usr/bin/ha \
        "https://github.com/home-assistant/cli/releases/download/${HA_CLI_VERSION}/ha_${HA_ARCH}" && \
    chmod +x /usr/bin/ha && \
    echo "Home Assistant CLI ${HA_CLI_VERSION} installed successfully"

# Install GitHub CLI (gh command) with SHA256 verification
# Download appropriate binary based on build architecture
# renovate: datasource=github-releases depName=cli/cli
ARG GH_CLI_VERSION=2.89.0
RUN set -eux; \
    # Determine architecture
    case "${TARGETARCH}" in \
        amd64)   GH_ARCH="amd64" ;; \
        arm64)   GH_ARCH="arm64" ;; \
        *)       echo "Unsupported architecture for gh: ${TARGETARCH}" && exit 1 ;; \
    esac; \
    \
    # Base URL for GitHub CLI releases
    BASE_URL="https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}"; \
    TARBALL="gh_${GH_CLI_VERSION}_linux_${GH_ARCH}.tar.gz"; \
    \
    # Download checksums file
    echo "Fetching GitHub CLI v${GH_CLI_VERSION} checksums..."; \
    curl -fsSL "${BASE_URL}/gh_${GH_CLI_VERSION}_checksums.txt" -o /tmp/gh_checksums.txt; \
    \
    # Extract expected checksum for our platform
    EXPECTED_SHA=$(grep "${TARBALL}" /tmp/gh_checksums.txt | awk '{print $1}'); \
    \
    # Validate checksum format
    if [ -z "$EXPECTED_SHA" ] || [ "$EXPECTED_SHA" = "null" ]; then \
        echo "ERROR: No checksum found for ${TARBALL}"; \
        exit 1; \
    fi; \
    \
    # Download binary tarball
    echo "Downloading GitHub CLI v${GH_CLI_VERSION} for ${GH_ARCH}..."; \
    curl -fsSL "${BASE_URL}/${TARBALL}" -o /tmp/gh.tar.gz; \
    \
    # Verify SHA256 checksum
    echo "Verifying binary integrity..."; \
    ACTUAL_SHA=$(sha256sum /tmp/gh.tar.gz | awk '{print $1}'); \
    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then \
        echo "ERROR: SHA256 mismatch!"; \
        echo "Expected: $EXPECTED_SHA"; \
        echo "Got:      $ACTUAL_SHA"; \
        rm -f /tmp/gh*; \
        exit 1; \
    fi; \
    \
    # Install verified binary
    echo "Installing GitHub CLI v${GH_CLI_VERSION}..."; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    mv /tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}/bin/gh /usr/bin/gh; \
    chmod +x /usr/bin/gh; \
    rm -rf /tmp/gh*; \
    \
    # Verify installation
    gh --version

# Pre-install ha-mcp (Home Assistant MCP Server) from locked dependencies
# Uses uv.lock for deterministic builds with pinned transitive dependencies
# The index-strategy in pyproject.toml allows uv to find packages across both
# the HA musllinux wheel index (UV_EXTRA_INDEX_URL) and PyPI
COPY ha-mcp/pyproject.toml ha-mcp/uv.lock /opt/ha-mcp/
# Vendor HA agent skills into the ha-mcp package.
# The skills are a git submodule in the ha-mcp repo but aren't included in
# the PyPI package. ha-mcp expects them at ha_mcp/resources/skills-vendor/skills/.
# renovate: datasource=git-refs depName=homeassistant-ai/skills packageName=https://github.com/homeassistant-ai/skills branch=main
ARG HA_SKILLS_COMMIT=9c41da3a09876b46d1610c0590f5356db72e566f
RUN cd /opt/ha-mcp \
    && uv sync --locked --no-dev --no-editable \
    && echo "ha-mcp installed at /opt/ha-mcp/.venv/bin/ha-mcp" \
    && HA_MCP_PKG="$(/opt/ha-mcp/.venv/bin/python -c 'import ha_mcp, pathlib; print(pathlib.Path(ha_mcp.__file__).parent)')" \
    && git clone https://github.com/homeassistant-ai/skills.git "${HA_MCP_PKG}/resources/skills-vendor" \
    && cd "${HA_MCP_PKG}/resources/skills-vendor" \
    && git checkout "${HA_SKILLS_COMMIT}" \
    && rm -rf .git \
    && echo "HA agent skills (${HA_SKILLS_COMMIT}) vendored into ${HA_MCP_PKG}/resources/skills-vendor/"

# Create directory for Claude configuration and set working directory
RUN mkdir -p /config/claude-config
WORKDIR /config

# Copy and install wrapper service (UI, terminal proxy, image uploads, mouse toggle)
# Images built in GitHub Actions with controlled environment
COPY wrapper/package*.json /opt/wrapper/
RUN cd /opt/wrapper \
    && npm ci --production --ignore-scripts \
    && npm cache clean --force

COPY wrapper/ /opt/wrapper/
RUN chmod +x /opt/wrapper/server.js

# Copy startup script and modular scripts
COPY run.sh /run.sh
COPY scripts/ /opt/scripts/
COPY .claude/ /opt/.claude/
RUN chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh

# Use exec form for better signal handling
CMD ["/run.sh"]