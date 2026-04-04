#!/usr/bin/env bash
# Last Light Docker entrypoint
# Symlinks secrets from the mounted volume into HERMES_HOME, then starts the agent.
set -euo pipefail

SECRETS="/opt/lastlight/secrets"
HOME_DIR="/opt/lastlight"

# Symlink config files from secrets volume (if mounted)
for f in .env config.yaml; do
  if [ -f "$SECRETS/$f" ]; then
    ln -sf "$SECRETS/$f" "$HOME_DIR/$f"
    echo "Linked $f from secrets volume"
  fi
done

# Symlink any PEM files (GitHub App private key)
for pem in "$SECRETS"/*.pem; do
  if [ -f "$pem" ]; then
    ln -sf "$pem" "$HOME_DIR/$(basename "$pem")"
    echo "Linked $(basename "$pem") from secrets volume"
  fi
done

# Ensure runtime directories exist
mkdir -p "$HOME_DIR"/{sessions,logs,memories,cache}

# Source .env if available
if [ -f "$HOME_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME_DIR/.env"
  set +a
fi

echo "Starting Last Light (HERMES_HOME=$HOME_DIR)..."
exec "$HOME_DIR/lastlight" "$@"
