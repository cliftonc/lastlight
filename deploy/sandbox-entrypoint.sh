#!/usr/bin/env bash
# Sandbox container entrypoint — runs as root after volumes are mounted.
# Sets up permissions, Claude auth, skills, agent-context, MCP config,
# git identity, then drops to agent user via gosu.
set -euo pipefail

AGENT_HOME="/home/agent"
WORKSPACE="$AGENT_HOME/workspace"

# ── Fix workspace ownership (bind-mounts may be root-owned on macOS) ──
chown -R agent:agent "$WORKSPACE" 2>/dev/null || true
chown agent:agent "$AGENT_HOME"

# ── ~/.claude as a real directory ──
# Skills symlinked from baked-in /app/skills. Auth linked from shared volume.
mkdir -p "$AGENT_HOME/.claude"
chown agent:agent "$AGENT_HOME/.claude"

# Skills: direct symlink to baked-in path
ln -sfn /app/skills "$AGENT_HOME/.claude/skills"

# Keep the shared app PEM unreadable by the unprivileged agent by default.
if [ -f /data/secrets/app.pem ]; then
  chmod 600 /data/secrets/app.pem 2>/dev/null || true
fi

# Optionally materialize an agent-readable PEM for high-trust runs only.
if [ "${ALLOW_APP_PEM:-0}" = "1" ] && [ -f /data/secrets/app.pem ]; then
  cp /data/secrets/app.pem "$AGENT_HOME/.claude/app.pem"
  chown agent:agent "$AGENT_HOME/.claude/app.pem"
  chmod 600 "$AGENT_HOME/.claude/app.pem"
  export GITHUB_APP_PRIVATE_KEY_PATH="$AGENT_HOME/.claude/app.pem"
else
  export GITHUB_APP_PRIVATE_KEY_PATH=""
fi

# Auth: link children of shared claude-home (sessions, settings, etc.)
if [ -d /data/claude-home ]; then
  # Ensure auth files are readable by agent (they may be owned by a different user)
  chmod -R a+rX /data/claude-home/ 2>/dev/null || true
  chmod a+r /data/claude-home/.credentials.json 2>/dev/null || true

  for item in /data/claude-home/* /data/claude-home/.credentials.json /data/claude-home/.claude.json; do
    [ ! -e "$item" ] && continue
    base="$(basename "$item")"
    [ "$base" = "skills" ] && continue  # don't override our skills
    ln -sfn "$item" "$AGENT_HOME/.claude/$base"
  done

  # Ensure session logs are written to the shared volume so the dashboard can read them
  mkdir -p /data/claude-home/projects
  chown agent:agent /data/claude-home/projects
  ln -sfn /data/claude-home/projects "$AGENT_HOME/.claude/projects"
fi

# ── Agent context (CLAUDE.md) into workspace root ──
cat /app/agent-context/*.md > "$WORKSPACE/CLAUDE.md" 2>/dev/null || true
chown agent:agent "$WORKSPACE/CLAUDE.md" 2>/dev/null || true

# ── MCP config from template ──
envsubst '$GITHUB_APP_ID $GITHUB_APP_INSTALLATION_ID $GITHUB_APP_PRIVATE_KEY_PATH $GITHUB_TOKEN' \
  < /app/mcp-config.tmpl.json > "$WORKSPACE/.mcp.json"
chown agent:agent "$WORKSPACE/.mcp.json"

# ── Git identity and auth (system-wide so it applies regardless of exec user) ──
git config --system user.name "last-light[bot]"
git config --system user.email "last-light[bot]@users.noreply.github.com"

# If the harness passed a GIT_TOKEN, set up credential helper so git just works
if [ -n "${GIT_TOKEN:-}" ]; then
  git config --system credential.helper \
    '!f() { echo "username=x-access-token"; echo "password='"$GIT_TOKEN"'"; }; f'
fi

# ── Drop to agent user ──
exec gosu agent "$@"
