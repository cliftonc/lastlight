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

# Generate .gitconfig-bot from env vars so commits identify as the
# configured GitHub App (synced into sandboxes via terminal.credential_files).
if [ -n "${GITHUB_APP_BOT_NAME:-}" ] && [ -n "${GITHUB_APP_BOT_USER_ID:-}" ]; then
  cat > "$HOME_DIR/.gitconfig-bot" <<EOF
[credential "https://github.com"]
	helper = !f() { echo "password=\$(cat /root/.hermes/.gh-token)"; echo "username=x-access-token"; }; f

[user]
	name = ${GITHUB_APP_BOT_NAME}[bot]
	email = ${GITHUB_APP_BOT_USER_ID}+${GITHUB_APP_BOT_NAME}[bot]@users.noreply.github.com
EOF
  echo "Generated .gitconfig-bot for ${GITHUB_APP_BOT_NAME}[bot]"
fi

echo "Starting Last Light (HERMES_HOME=$HOME_DIR)..."
exec "$HOME_DIR/lastlight" "$@"
