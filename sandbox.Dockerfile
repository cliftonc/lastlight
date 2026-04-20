# Sandbox image for Last Light agent tasks.
# Immutable assets baked at /app/. Entrypoint wires them into the workspace
# after volumes are mounted, then drops to the runtime user.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gettext-base gosu \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep \
    && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
       | tar -xz -C /usr/local/bin gitleaks \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

# Install Claude Code CLI (binary goes to ~/.local/bin/)
# Remove ~/.claude/ after install — entrypoint recreates it at runtime.
USER agent
RUN curl -fsSL https://claude.ai/install.sh | bash && rm -rf /home/agent/.claude
USER root
ENV PATH="/home/agent/.local/bin:${PATH}"

# MCP server (baked at /app/)
COPY mcp-github-app/package.json /app/mcp-github-app/package.json
RUN cd /app/mcp-github-app && npm install --prefer-offline --no-audit && npm cache clean --force
COPY mcp-github-app/ /app/mcp-github-app/

# Skills (baked at /app/ — entrypoint symlinks into ~/.claude/skills/)
COPY skills/ /app/skills/

# Agent context (baked at /app/ — entrypoint cats into workspace/CLAUDE.md)
COPY agent-context/ /app/agent-context/

# Entrypoint + MCP config template
COPY deploy/sandbox-entrypoint.sh /app/sandbox-entrypoint.sh
COPY deploy/mcp-config.tmpl.json /app/mcp-config.tmpl.json
RUN chmod +x /app/sandbox-entrypoint.sh

# Own app dir for agent user
RUN chown -R agent:agent /app /home/agent

WORKDIR /home/agent/workspace

# Entrypoint runs as root, fixes permissions, then drops to agent via gosu
ENTRYPOINT ["/app/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
