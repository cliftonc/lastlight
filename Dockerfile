FROM debian:13.4

# System dependencies: Python 3, Node.js, git, build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev python3-venv \
    build-essential gcc libffi-dev \
    nodejs npm \
    git ripgrep curl jq openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Hermes Agent from source (not published on PyPI)
# Expensive — keep cached across rebuilds unless Hermes itself updates.
RUN git clone --depth 1 https://github.com/NousResearch/hermes-agent.git /opt/hermes && \
    pip install --no-cache-dir --break-system-packages -e "/opt/hermes[all]"

WORKDIR /root

# Layers ordered from least-frequently-changed to most-frequently-changed
# so small edits (e.g. SOUL.md tweaks) don't bust expensive layers.

# MCP server deps — rarely change
COPY mcp-github-app/ mcp-github-app/
RUN cd mcp-github-app && npm install --prefer-offline --no-audit \
    && npm cache clean --force

# Deploy scripts, helper scripts — rarely change
COPY scripts/ scripts/
COPY deploy/ deploy/

# Runtime dirs, mount points, env, port
RUN mkdir -p sessions logs memories
VOLUME ["/root/secrets"]
ENV HERMES_HOME=/root
EXPOSE 8644

# Launcher + config templates — occasional changes
COPY lastlight config.yaml.example .env.example ./
RUN chmod +x /root/deploy/entrypoint.sh /root/lastlight

# Scheduled jobs — occasional changes
COPY cron/ cron/

# Skills — changes often
COPY skills/ skills/

# Project context & personality — most frequently changed
COPY .hermes.md SOUL.md ./

ENTRYPOINT ["/root/deploy/entrypoint.sh"]
CMD ["gateway"]
