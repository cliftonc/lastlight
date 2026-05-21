#!/usr/bin/env bash
# Run the lastlight harness on your local machine without polluting your
# host environment. Specifically:
#   - The harness does NOT touch your ~/.gitconfig (this is the default
#     behaviour; it would require an explicit LASTLIGHT_WRITE_GLOBAL_GIT=1
#     opt-in to do so, which we never set here).
#   - Bind-mounts a project-local directory (./data/sandbox-data) into each
#     sandbox container as /data, instead of the production named volume
#     `lastlight_agent-data`.
#   - Points STATE_DIR and OPENCODE_HOME_DIR at ./data so the SQLite db,
#     execution logs, and dashboard session reads stay project-local.
#
# Pre-requisites:
#   - Docker Desktop (or compatible) running and accessible from your shell
#   - The sandbox image built locally:
#       docker compose --profile build-only build sandbox
#   - .env in the project root with GITHUB_APP_* / OPENAI_API_KEY /
#     WEBHOOK_SECRET / etc.
#
# Usage:
#   npm run dev:local
#
set -euo pipefail

# ── Resolve project root regardless of where the script is called from ────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Project-local equivalent of the production lastlight_agent-data Docker
# named volume. The sandbox containers bind-mount this directory as /data.
# Inside the container, the layout MUST match what deploy/sandbox-entrypoint.sh
# expects:
#   /data/opencode-home/projects/...  (session JSONLs, written by harness shim)
#   /data/secrets/app.pem             (GitHub App private key)
SANDBOX_DATA_DIR="$PROJECT_ROOT/data/sandbox-data"
LOCAL_OPENCODE_HOME="$SANDBOX_DATA_DIR/opencode-home"
LOCAL_SECRETS="$SANDBOX_DATA_DIR/secrets"

# ── Verify the sandbox image exists locally ───────────────────────────────
if ! docker images -q lastlight-sandbox:latest | grep -q .; then
  echo "ERROR: Docker image lastlight-sandbox:latest not found." >&2
  echo "Build it with:" >&2
  echo "  docker compose --profile build-only build sandbox" >&2
  exit 1
fi

# ── Locate opencode binary for the chat server ───────────────────────────
# The chat-server supervisor spawns `opencode serve` on harness boot. Use
# the project-local install (`opencode-ai` is a devDependency) so `npm
# install` provisions it automatically. Falls back to whatever's on PATH
# if the user prefers a system-wide install.
LOCAL_OPENCODE_BIN="$PROJECT_ROOT/node_modules/.bin/opencode"
if [ -x "$LOCAL_OPENCODE_BIN" ]; then
  export OPENCODE_BIN="$LOCAL_OPENCODE_BIN"
elif ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: opencode binary not found." >&2
  echo "Run \`npm install\` to install the opencode-ai devDependency, or" >&2
  echo "install opencode globally and put it on PATH." >&2
  exit 1
fi

mkdir -p "$LOCAL_OPENCODE_HOME/projects"

# ── Copy GitHub App private key for the in-sandbox MCP server ─────────────
# The opencode.json template at deploy/opencode-config.tmpl.json points at
# /home/agent/.config/app.pem, materialized by sandbox-entrypoint from the
# bind-mounted secrets dir at /data/secrets/app.pem.
mkdir -p "$LOCAL_SECRETS"

# Source .env so we can find GITHUB_APP_PRIVATE_KEY_PATH
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

if [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ] && [ -f "$GITHUB_APP_PRIVATE_KEY_PATH" ]; then
  echo "[dev-local] Seeding GitHub App PEM from $GITHUB_APP_PRIVATE_KEY_PATH"
  cp "$GITHUB_APP_PRIVATE_KEY_PATH" "$LOCAL_SECRETS/app.pem"
  chmod 600 "$LOCAL_SECRETS/app.pem"
else
  echo "WARNING: GITHUB_APP_PRIVATE_KEY_PATH not set or file not found." >&2
  echo "         The in-sandbox GitHub MCP server will fail to start." >&2
  echo "         Set GITHUB_APP_PRIVATE_KEY_PATH=./your-app.private-key.pem in .env" >&2
fi

# ── Environment overrides for safe local execution ────────────────────────
# - SANDBOX_DATA_VOLUME=…     → bind-mount sandbox-data dir as /data inside
#                               each sandbox container
# - OPENCODE_HOME_DIR=…       → dashboard reads sandbox sessions from here
# - STATE_DIR=./data          → SQLite db, sandboxes/, logs/ stay project-local
# - ENABLE_DIRECT_FALLBACK=false → require sandbox; never fall back to direct
#   in-process execution
#
# LASTLIGHT_WRITE_GLOBAL_GIT is intentionally NOT set — the harness's default
# is to leave ~/.gitconfig alone; sandboxes receive the GitHub App token via
# the GIT_TOKEN env var and configure git --system inside the container.
export SANDBOX_DATA_VOLUME="$SANDBOX_DATA_DIR"
export STATE_DIR="$PROJECT_ROOT/data"
export OPENCODE_HOME_DIR="$LOCAL_OPENCODE_HOME"
export ENABLE_DIRECT_FALLBACK=false

echo "[dev-local] SANDBOX_DATA_VOLUME=$SANDBOX_DATA_VOLUME (bind-mounted as /data)"
echo "[dev-local] OPENCODE_HOME_DIR=$OPENCODE_HOME_DIR"
echo "[dev-local] STATE_DIR=$STATE_DIR"
echo "[dev-local] OPENCODE_BIN=${OPENCODE_BIN:-$(command -v opencode)}"
echo "[dev-local] Starting harness with hot reload..."

exec npx tsx watch src/index.ts
