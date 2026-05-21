FROM node:22-slim

# System deps: git, ripgrep, docker CLI, gosu, python3/make/g++ (for native modules like better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gosu \
    python3 make g++ \
    && curl -fsSL https://get.docker.com | sh \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user. Add to docker group so they can spawn sandbox
# containers via socket.
RUN useradd -m -s /bin/bash lastlight && usermod -aG docker lastlight

WORKDIR /app

# Make the opencode-ai binary (installed via npm into /app/node_modules)
# resolvable on PATH for the long-lived `opencode serve` chat supervisor,
# which spawns plain `opencode` unless OPENCODE_BIN is set.
ENV PATH="/app/node_modules/.bin:${PATH}"

# MCP server deps — rarely change
COPY mcp-github-app/package.json mcp-github-app/package.json
RUN cd mcp-github-app && npm install --prefer-offline --no-audit \
    && npm cache clean --force
COPY mcp-github-app/ mcp-github-app/

# Harness deps — change when package.json changes
COPY package.json package-lock.json* ./
COPY dashboard/package.json dashboard/package.json
RUN npm install --prefer-offline --no-audit \
    && npm cache clean --force

# TypeScript config
COPY tsconfig.json ./

# Harness source — changes often
COPY src/ src/

# Dashboard source
COPY dashboard/ dashboard/

# Build TypeScript harness + dashboard
RUN npm run build && npm run build:dashboard

# Deploy scripts — rarely change
COPY deploy/ deploy/
RUN chmod +x /app/deploy/entrypoint.sh

# Frequently changing content — copied last for best cache hits, owned by lastlight
COPY --chown=lastlight:lastlight skills/ skills/
COPY --chown=lastlight:lastlight agent-context/ agent-context/
COPY --chown=lastlight:lastlight workflows/ workflows/
COPY --chown=lastlight:lastlight CLAUDE.md ./

# Let lastlight user write to /app (for mcp-config.json at startup)
# Only chown /app itself, not recursively — node_modules etc. are read-only and fine as root
RUN chown lastlight:lastlight /app

# State directory — mount as Docker volume
# Entrypoint handles chown on /app/data at runtime
RUN mkdir -p /app/data/sessions /app/data/logs
VOLUME ["/app/data", "/app/secrets"]

ENV STATE_DIR=/app/data
ENV OPENCODE_HOME_DIR=/app/data/opencode-home
ENV HOME=/home/lastlight
ENV NODE_ENV=production
EXPOSE 8644

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
CMD ["node", "dist/index.js"]
