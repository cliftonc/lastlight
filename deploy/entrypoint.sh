#!/usr/bin/env bash
# Last Light Docker entrypoint
# Links secrets, ensures state dirs, then starts the harness.
set -euo pipefail

SECRETS="/app/secrets"
APP_DIR="/app"
STATE_DIR="${STATE_DIR:-/app/data}"

# Symlink secrets from mounted volume
for f in .env; do
  if [ -f "$SECRETS/$f" ]; then
    ln -sf "$SECRETS/$f" "$APP_DIR/$f"
    echo "Linked $f from secrets volume"
  fi
done

# Symlink PEM files (GitHub App private key)
for pem in "$SECRETS"/*.pem; do
  if [ -f "$pem" ]; then
    ln -sf "$pem" "$APP_DIR/$(basename "$pem")"
    echo "Linked $(basename "$pem") from secrets volume"
  fi
done

# Ensure state directory structure exists and is owned by lastlight
mkdir -p "$STATE_DIR"/{sessions,logs,sandboxes,secrets,claude-home}
chown -R lastlight:lastlight "$STATE_DIR"

# Copy PEM to the data volume so sandbox containers can access it via shared volume
for pem in "$SECRETS"/*.pem; do
  if [ -f "$pem" ]; then
    cp "$pem" "$STATE_DIR/secrets/app.pem"
    chmod 600 "$STATE_DIR/secrets/app.pem"
    echo "Copied PEM to data volume for sandbox access"
    break
  fi
done

# Persist Claude auth and sessions via the state volume
# This means `docker exec claude login` survives container restarts
mkdir -p "$STATE_DIR/claude-home"
# Remove the dir created by the installer, replace with symlink to volume
CLAUDE_HOME="${HOME:-/home/lastlight}/.claude"
rm -rf "$CLAUDE_HOME"
ln -sfn "$STATE_DIR/claude-home" "$CLAUDE_HOME"

# Source .env if available
if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_DIR/.env"
  set +a
fi

# Fix Docker socket permissions — host GID may differ from container docker group
if [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock
fi

echo "Starting Last Light (state: $STATE_DIR)..."
# Drop to non-root — Claude Code blocks bypassPermissions as root
exec gosu lastlight "$@"
