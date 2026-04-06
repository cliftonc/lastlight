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

# Auth: link children of shared claude-home (sessions, settings, etc.)
if [ -d /data/claude-home ]; then
  # Ensure auth files are readable by agent (they may be owned by a different user)
  chmod -R a+rX /data/claude-home/ 2>/dev/null || true
  chmod a+r /data/claude-home/.credentials.json 2>/dev/null || true

  for item in /data/claude-home/* /data/claude-home/.credentials.json; do
    [ ! -e "$item" ] && continue
    base="$(basename "$item")"
    [ "$base" = "skills" ] && continue  # don't override our skills
    ln -sfn "$item" "$AGENT_HOME/.claude/$base"
  done
fi

# ── Agent context (CLAUDE.md) into workspace root ──
cat /app/agent-context/*.md > "$WORKSPACE/CLAUDE.md" 2>/dev/null || true
chown agent:agent "$WORKSPACE/CLAUDE.md" 2>/dev/null || true

# ── MCP config from template ──
envsubst '$GITHUB_APP_ID $GITHUB_APP_INSTALLATION_ID' \
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
