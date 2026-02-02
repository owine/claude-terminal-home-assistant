ARG BUILD_FROM
FROM ${BUILD_FROM}

# Install packages in a single layer to minimize image size
# Node.js and npm kept for image-service dependency
RUN apk add --no-cache \
    nodejs \
    npm \
    bash \
    curl \
    nano \
    python3 \
    py3-pip \
    py3-requests \
    py3-aiohttp \
    py3-yaml \
    py3-beautifulsoup4 \
    jq \
    yq \
    git \
    vim \
    wget \
    tree \
    tmux

# Install Claude Code CLI using native installer (recommended by Anthropic)
# Creates symlink to /usr/local/bin for script compatibility
# renovate: datasource=custom.anthropic depName=claude-code
ARG CLAUDE_VERSION=latest
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

# Install uv for running ha-mcp (Python package manager/runner)
# ha-mcp requires Python 3.13+, uv handles this automatically
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=latest
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
    && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

# Install Home Assistant CLI (ha command)
# Download appropriate binary based on build architecture
# renovate: datasource=github-releases depName=home-assistant/cli
ARG HA_CLI_VERSION=latest
ARG TARGETARCH
RUN case "${TARGETARCH}" in \
        amd64)   HA_ARCH="amd64" ;; \
        arm64)   HA_ARCH="aarch64" ;; \
        arm/v7)  HA_ARCH="armv7" ;; \
        arm/v6)  HA_ARCH="armhf" ;; \
        386)     HA_ARCH="i386" ;; \
        *)       echo "Unsupported architecture: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    echo "Fetching latest Home Assistant CLI version..." && \
    HA_VERSION=$(curl -fsSL https://api.github.com/repos/home-assistant/cli/releases/latest | jq -r '.tag_name') && \
    echo "Installing Home Assistant CLI ${HA_VERSION} for ${HA_ARCH}..." && \
    curl -fsSL -o /usr/bin/ha \
        "https://github.com/home-assistant/cli/releases/download/${HA_VERSION}/ha_${HA_ARCH}" && \
    chmod +x /usr/bin/ha && \
    echo "Home Assistant CLI ${HA_VERSION} installed successfully"

# Install GitHub CLI (gh command)
# Download appropriate binary based on build architecture
# renovate: datasource=github-releases depName=cli/cli
ARG GH_CLI_VERSION=latest
RUN case "${TARGETARCH}" in \
        amd64)   GH_ARCH="amd64" ;; \
        arm64)   GH_ARCH="arm64" ;; \
        arm/v7)  GH_ARCH="armv7" ;; \
        386)     GH_ARCH="386" ;; \
        *)       echo "Unsupported architecture for gh: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    echo "Fetching latest GitHub CLI version..." && \
    GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//') && \
    echo "Installing GitHub CLI v${GH_VERSION} for ${GH_ARCH}..." && \
    curl -fsSL -o /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv /tmp/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh /usr/bin/gh && \
    chmod +x /usr/bin/gh && \
    rm -rf /tmp/gh* && \
    echo "GitHub CLI v${GH_VERSION} installed successfully"

# Create directory for Claude configuration and set working directory
RUN mkdir -p /config/claude-config
WORKDIR /config

# Copy and install image service
# NOTE: node_modules is bundled in repository due to HA build system
# not respecting package-lock.json or exact version pins
COPY image-service/ /opt/image-service/
RUN chmod +x /opt/image-service/server.js

# Copy startup script and modular scripts
COPY run.sh /run.sh
COPY scripts/ /opt/scripts/
COPY .claude/ /opt/.claude/
RUN chmod +x /run.sh \
    && chmod +x /opt/scripts/*.sh

# Use exec form for better signal handling
CMD ["/run.sh"]