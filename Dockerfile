FROM debian:13.4

# System dependencies: Python 3, Node.js, git, build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-dev python3-venv \
    build-essential gcc libffi-dev \
    nodejs npm \
    git ripgrep curl jq openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Hermes Agent from source (not published on PyPI)
RUN git clone --depth 1 https://github.com/NousResearch/hermes-agent.git /opt/hermes && \
    pip install --no-cache-dir --break-system-packages -e "/opt/hermes[all]"

WORKDIR /opt/lastlight

# Copy project files (skills, MCP server, scripts, launcher)
# .dockerignore excludes secrets, state, and bundled skills
COPY skills/ skills/
COPY mcp-github-app/ mcp-github-app/
COPY scripts/ scripts/
COPY deploy/ deploy/
COPY cron/ cron/
COPY lastlight config.yaml.example .env.example .hermes.md SOUL.md ./

# Install MCP server Node.js dependencies
RUN cd mcp-github-app && npm install --prefer-offline --no-audit \
    && npm cache clean --force

# Runtime directories
RUN mkdir -p sessions logs memories

# Secrets mount point — users bind-mount their .env, config.yaml, PEM file
VOLUME ["/opt/lastlight/secrets"]

ENV HERMES_HOME=/opt/lastlight
EXPOSE 8644

RUN chmod +x /opt/lastlight/deploy/entrypoint.sh /opt/lastlight/lastlight
ENTRYPOINT ["/opt/lastlight/deploy/entrypoint.sh"]
CMD ["gateway"]
