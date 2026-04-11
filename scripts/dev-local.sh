#!/usr/bin/env bash
# Run the lastlight harness on your local machine without polluting your
# host environment. Specifically:
#   - Sets LASTLIGHT_LOCAL_DEV=1 so git-auth.ts skips `git config --global`
#     writes (so your ~/.gitconfig identity and credential helper are
#     untouched).
#   - Bind-mounts a project-local directory (./data/sandbox-claude-home) into
#     each sandbox container as the shared claude-home volume, instead of the
#     production named volume `lastlight_agent-data`. Your real ~/.claude is
#     never bind-mounted into a container.
#   - Seeds that local sandbox claude-home with a copy of your host
#     ~/.claude/.credentials.json (and .claude.json) on first run, so claude
#     inside the sandbox is logged in. Sandboxes can refresh tokens against
#     this copy without affecting your host login.
#   - Points STATE_DIR and CLAUDE_HOME_DIR at ./data so the SQLite db,
#     execution logs, and dashboard session reads stay project-local.
#
# Pre-requisites:
#   - Docker Desktop (or compatible) running and accessible from your shell
#   - The sandbox image built locally:
#       docker compose --profile build-only build sandbox
#   - You are already `claude /login`-ed on the host (~/.claude exists)
#   - .env in the project root with GITHUB_APP_* / WEBHOOK_SECRET / etc.
#
# Usage:
#   npm run dev:local
#
set -euo pipefail

# ── Resolve project root regardless of where the script is called from ────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

LOCAL_CLAUDE_HOME="$PROJECT_ROOT/data/sandbox-claude-home"
HOST_CLAUDE_HOME="${HOME}/.claude"

# ── Locate host claude credentials ────────────────────────────────────────
# Linux:  $HOME/.claude/.credentials.json
# macOS:  macOS keychain (entry: "Claude Code-credentials"), no JSON file
# We try the file first; fall back to keychain on macOS so dev:local works on
# both platforms without manual copying.
read_keychain_credentials() {
  if [ "$(uname)" != "Darwin" ]; then
    return 1
  fi
  security find-generic-password -s "Claude Code-credentials" -a "$USER" -w 2>/dev/null
}

# ── Verify the sandbox image exists locally ───────────────────────────────
if ! docker images -q lastlight-sandbox:latest | grep -q .; then
  echo "ERROR: Docker image lastlight-sandbox:latest not found." >&2
  echo "Build it with:" >&2
  echo "  docker compose --profile build-only build sandbox" >&2
  exit 1
fi

# ── Seed the project-local sandbox claude-home (re-seeded every run) ──────
# Sandboxes will write back to this dir on token refresh, but we always re-
# seed at startup so a fresh `claude /login` on the host (which rotates the
# token) is picked up automatically without the user having to wipe the dir.
# Refreshes that happen DURING a dev session still persist locally — they're
# only overwritten on the next dev start.
mkdir -p "$LOCAL_CLAUDE_HOME/projects"

if [ -f "$HOST_CLAUDE_HOME/.credentials.json" ]; then
  echo "[dev-local] Seeding credentials from $HOST_CLAUDE_HOME/.credentials.json"
  cp "$HOST_CLAUDE_HOME/.credentials.json" "$LOCAL_CLAUDE_HOME/.credentials.json"
elif KEYCHAIN_CREDS=$(read_keychain_credentials); then
  echo "[dev-local] Seeding credentials from macOS keychain (Claude Code-credentials)"
  printf '%s' "$KEYCHAIN_CREDS" > "$LOCAL_CLAUDE_HOME/.credentials.json"
  chmod 600 "$LOCAL_CLAUDE_HOME/.credentials.json"
else
  echo "ERROR: No claude credentials found." >&2
  echo "Tried:" >&2
  echo "  - $HOST_CLAUDE_HOME/.credentials.json" >&2
  if [ "$(uname)" = "Darwin" ]; then
    echo "  - macOS keychain entry 'Claude Code-credentials' for user $USER" >&2
  fi
  echo "Run \`claude /login\` first." >&2
  exit 1
fi

# Optional secondary config files — copy if present, otherwise skip
if [ -f "$HOST_CLAUDE_HOME/.claude.json" ]; then
  cp "$HOST_CLAUDE_HOME/.claude.json" "$LOCAL_CLAUDE_HOME/.claude.json"
fi

# ── Environment overrides for safe local execution ────────────────────────
# - LASTLIGHT_LOCAL_DEV=1   → git-auth.ts skips `git config --global` writes
# - SANDBOX_DATA_VOLUME=… → bind-mount the project-local claude-home
# - STATE_DIR / CLAUDE_HOME_DIR → keep all state under ./data
# - ENABLE_DIRECT_FALLBACK=false → require sandbox; never fall back to direct
#   in-process execution which would write to your real ~/.claude/projects/
export LASTLIGHT_LOCAL_DEV=1
export SANDBOX_DATA_VOLUME="$LOCAL_CLAUDE_HOME"
export STATE_DIR="$PROJECT_ROOT/data"
export CLAUDE_HOME_DIR="$LOCAL_CLAUDE_HOME"
export ENABLE_DIRECT_FALLBACK=false

echo "[dev-local] LASTLIGHT_LOCAL_DEV=1"
echo "[dev-local] SANDBOX_DATA_VOLUME=$SANDBOX_DATA_VOLUME"
echo "[dev-local] STATE_DIR=$STATE_DIR"
echo "[dev-local] CLAUDE_HOME_DIR=$CLAUDE_HOME_DIR"
echo "[dev-local] Starting harness with hot reload..."

exec npx tsx watch src/index.ts
