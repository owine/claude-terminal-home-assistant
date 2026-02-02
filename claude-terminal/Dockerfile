# Home Assistant base image
# renovate: datasource=docker depName=ghcr.io/home-assistant/amd64-base
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23@sha256:7de749eb4528709824b48f1fe00ea0f981b01cca0b65e1bd633c85081beb1ada
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
# Set PATH before installation to silence installer warnings
# Creates symlink to /usr/local/bin for script compatibility
# renovate: datasource=custom.anthropic depName=claude-code
ARG CLAUDE_VERSION=latest
RUN export PATH="$HOME/.local/bin:$PATH" \
    && curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude

# Install uv for running ha-mcp (Python package manager/runner)
# ha-mcp requires Python 3.13+, uv handles this automatically
# renovate: datasource=github-releases depName=astral-sh/uv
ARG UV_VERSION=0.9.28
RUN export UV_INSTALL_VERSION="${UV_VERSION}" \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
    && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

# Install Home Assistant CLI (ha command)
# Download appropriate binary based on build architecture
# renovate: datasource=github-releases depName=home-assistant/cli
ARG HA_CLI_VERSION=4.45.0
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

# Install GitHub CLI (gh command)
# Download appropriate binary based on build architecture
# renovate: datasource=github-releases depName=cli/cli
ARG GH_CLI_VERSION=2.86.0
RUN case "${TARGETARCH}" in \
        amd64)   GH_ARCH="amd64" ;; \
        arm64)   GH_ARCH="arm64" ;; \
        *)       echo "Unsupported architecture for gh: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    echo "Installing GitHub CLI v${GH_CLI_VERSION} for ${GH_ARCH}..." && \
    curl -fsSL -o /tmp/gh.tar.gz \
        "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}.tar.gz" && \
    tar -xzf /tmp/gh.tar.gz -C /tmp && \
    mv /tmp/gh_${GH_CLI_VERSION}_linux_${GH_ARCH}/bin/gh /usr/bin/gh && \
    chmod +x /usr/bin/gh && \
    rm -rf /tmp/gh* && \
    echo "GitHub CLI v${GH_CLI_VERSION} installed successfully"

# Create directory for Claude configuration and set working directory
RUN mkdir -p /config/claude-config
WORKDIR /config

# Copy and install image service
# Images built in GitHub Actions with controlled environment
COPY image-service/package*.json /opt/image-service/
RUN cd /opt/image-service \
    && npm ci --production --ignore-scripts \
    && npm cache clean --force

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