# Sandbox image for Last Light agent tasks.
# Immutable assets baked at /app/. Entrypoint wires them into the workspace
# after volumes are mounted, then drops to the runtime user.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ripgrep curl jq ca-certificates gettext-base gosu \
    build-essential pkg-config python3 unzip \
    && rm -rf /var/lib/apt/lists/*

# fnm + multiple Node versions so repos pinning a specific Node via .nvmrc /
# package.json#engines just work. System node from the base image stays at /usr/local/bin
# (used by opencode itself); fnm-managed versions are pre-installed under
# FNM_DIR and selected per-shell by the bashrc hook below.
ENV FNM_DIR=/usr/local/share/fnm
ENV PATH=$FNM_DIR/aliases/default/bin:$PATH
RUN curl -fsSL https://fnm.vercel.app/install \
      | bash -s -- --install-dir "$FNM_DIR" --skip-shell \
 && ln -s "$FNM_DIR/fnm" /usr/local/bin/fnm \
 && fnm install 22 \
 && fnm install 24 \
 && fnm default 22 \
 && chmod -R a+rX "$FNM_DIR" \
 && mkdir -p "$FNM_DIR/multishells" \
 && chmod 1777 "$FNM_DIR/multishells"

# Source fnm in every bash invocation (interactive or not). BASH_ENV makes
# non-interactive `bash -c` read this file — that's how opencode's bash tool
# inherits the right node version when it runs `npm ci` inside a repo with
# an .nvmrc pinning Node 24.
RUN printf '%s\n' \
    'export FNM_DIR=/usr/local/share/fnm' \
    'export PATH="$FNM_DIR:$PATH"' \
    '# --shell bash is required: when sourced via BASH_ENV the parent process' \
    '# is not a shell so fnm cannot auto-detect.' \
    'eval "$(fnm env --shell bash --use-on-cd --version-file-strategy=recursive)"' \
    '# The cd hook fires only on cd. opencode often launches `bash -c "..."`' \
    '# with cwd already set via the spawn options — no cd happens — so also' \
    '# auto-switch on shell start when the cwd has a version file.' \
    'if [ -f "$PWD/.nvmrc" ] || [ -f "$PWD/.node-version" ]; then' \
    '  fnm use --silent-if-unchanged 2>/dev/null \' \
    '    || { fnm install 2>/dev/null && fnm use --silent-if-unchanged 2>/dev/null; } \' \
    '    || true' \
    'fi' \
    > /etc/bash.bashrc.fnm \
 && printf '\n[ -r /etc/bash.bashrc.fnm ] && . /etc/bash.bashrc.fnm\n' >> /etc/bash.bashrc \
 && ln -s /etc/bash.bashrc.fnm /etc/profile.d/fnm.sh
# Source the fnm file directly — Debian's /etc/bash.bashrc bails early on
# non-interactive shells (`[ -z "$PS1" ] && return`), so pointing BASH_ENV at
# it would skip our setup for `bash -c` invocations (which is exactly the
# path opencode's bash tool uses).
ENV BASH_ENV=/etc/bash.bashrc.fnm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep \
    && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
       | tar -xz -C /usr/local/bin gitleaks \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

# Install OpenCode CLI (pinned; see .spike/PHASE0-FINDINGS.md). Global npm
# install puts the binary on PATH at /usr/local/bin/opencode for all users.
# Integrity hash matches the value in the harness package-lock.json — verified
# explicitly because `npm install -g <name>@<version>` doesn't consult any
# lockfile, so without this a republished/compromised tarball would land
# silently. To bump: copy the new `sha512-…` from `package-lock.json`
# (node_modules/opencode-ai → integrity field) along with the version.
ARG OPENCODE_VERSION=1.15.5
ARG OPENCODE_INTEGRITY=sha512-ud/0sYo9h2BJALwLudRrzs551YJoi+rHo66jEsSLdOBv5RJxmN64aqqGaafhWxvgtaHyEOqfKnZPyx9GVKl/UA==
RUN curl -fsSL "https://registry.npmjs.org/opencode-ai/-/opencode-ai-${OPENCODE_VERSION}.tgz" -o /tmp/opencode-ai.tgz \
 && actual="sha512-$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha512').update(f.readFileSync('/tmp/opencode-ai.tgz')).digest('base64'))")" \
 && if [ "$actual" != "$OPENCODE_INTEGRITY" ]; then \
      echo "opencode-ai tarball integrity mismatch:" >&2; \
      echo "  expected: $OPENCODE_INTEGRITY" >&2; \
      echo "  actual:   $actual" >&2; \
      exit 1; \
    fi \
 && npm install -g --no-audit --no-fund /tmp/opencode-ai.tgz \
 && rm /tmp/opencode-ai.tgz

# MCP server (baked at /app/)
COPY mcp-github-app/package.json /app/mcp-github-app/package.json
RUN cd /app/mcp-github-app && npm install --prefer-offline --no-audit && npm cache clean --force
COPY mcp-github-app/ /app/mcp-github-app/

# Agent context (baked at /app/ — entrypoint cats into workspace/AGENTS.md)
COPY agent-context/ /app/agent-context/

# Entrypoint + OpenCode config template
COPY deploy/sandbox-entrypoint.sh /app/sandbox-entrypoint.sh
COPY deploy/opencode-config.tmpl.json /app/opencode-config.tmpl.json
RUN chmod +x /app/sandbox-entrypoint.sh

# Own app dir for agent user
RUN chown -R agent:agent /app /home/agent

WORKDIR /home/agent/workspace

# Image-level env so every `docker exec` (the entrypoint just runs once at
# container start) sees these. Exporting them in sandbox-entrypoint.sh only
# affects PID 1 — subsequent `docker exec opencode run …` calls get a fresh
# environment and would otherwise miss these paths.
ENV LASTLIGHT_WORKSPACE=/home/agent/workspace
ENV LASTLIGHT_GIT_CREDENTIALS=/home/agent/.lastlight-git-credentials

# Entrypoint runs as root, fixes permissions, then drops to agent via gosu
ENTRYPOINT ["/app/sandbox-entrypoint.sh"]
CMD ["sleep", "infinity"]
