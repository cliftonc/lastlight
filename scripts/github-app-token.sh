#!/usr/bin/env bash
# Generate a GitHub App installation token from App credentials.
# Caches the token and only regenerates when it expires (with 5-min buffer).
#
# Requires: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID in .env
# Dependencies: openssl, curl, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CACHE_FILE="$PROJECT_DIR/.github-token-cache.json"

# Load .env
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

: "${GITHUB_APP_ID:?Set GITHUB_APP_ID in .env}"
: "${GITHUB_APP_PRIVATE_KEY_PATH:?Set GITHUB_APP_PRIVATE_KEY_PATH in .env}"
: "${GITHUB_APP_INSTALLATION_ID:?Set GITHUB_APP_INSTALLATION_ID in .env}"

# Resolve relative paths
if [[ "$GITHUB_APP_PRIVATE_KEY_PATH" != /* ]]; then
  GITHUB_APP_PRIVATE_KEY_PATH="$PROJECT_DIR/$GITHUB_APP_PRIVATE_KEY_PATH"
fi

# Check cache — reuse if token expires more than 5 minutes from now
if [[ -f "$CACHE_FILE" ]]; then
  now=$(date +%s)
  expires_at=$(jq -r '.expires_at // empty' "$CACHE_FILE" 2>/dev/null || true)
  cached_token=$(jq -r '.token // empty' "$CACHE_FILE" 2>/dev/null || true)

  if [[ -n "$expires_at" && -n "$cached_token" ]]; then
    # Parse ISO 8601 expiry to epoch
    if expires_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$expires_at" +%s 2>/dev/null) ||
       expires_epoch=$(date -d "$expires_at" +%s 2>/dev/null); then
      buffer=300  # 5 minutes
      if (( expires_epoch - now > buffer )); then
        echo "$cached_token"
        exit 0
      fi
    fi
  fi
fi

# Generate JWT
now=$(date +%s)
iat=$((now - 60))
exp=$((now + 600))

header=$(printf '{"alg":"RS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$iat" "$exp" "$GITHUB_APP_ID" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -sign "$GITHUB_APP_PRIVATE_KEY_PATH" -binary | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
jwt="${header}.${payload}.${signature}"

# Exchange JWT for installation token (capture full response for expiry)
response=$(curl -sf -X POST \
  -H "Authorization: Bearer ${jwt}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens")

token=$(echo "$response" | jq -r '.token')
expires_at=$(echo "$response" | jq -r '.expires_at')

if [[ -z "$token" || "$token" == "null" ]]; then
  echo "ERROR: Failed to get installation token" >&2
  exit 1
fi

# Cache token with expiry
printf '{"token":"%s","expires_at":"%s","generated_at":"%s"}\n' \
  "$token" "$expires_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$CACHE_FILE"
chmod 600 "$CACHE_FILE"

echo "$token"
