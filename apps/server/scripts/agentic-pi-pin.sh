#!/usr/bin/env bash
# Regenerate / verify sandbox/agentic-pi.pin — the two-line
# (version, sha512 integrity) pin the sandbox images use to install agentic-pi.
#
# WHY a committed pin file: the sandbox Dockerfiles install the PUBLISHED
# agentic-pi from npm (`curl .../agentic-pi-<version>.tgz` + explicit integrity
# check), NOT the in-repo build. agentic-pi now lives in this monorepo as a
# workspace package (packages/agentic-pi) consumed via `workspace:*`, so the
# pnpm-lock.yaml no longer carries a registry `resolution.integrity` for it —
# the pin is therefore derived from the package's own version
# (packages/agentic-pi/package.json) plus the integrity npm reports for that
# published version. Keeping the sandbox on the published tarball keeps its
# agentic-pi layer (and sandbox-qa's ~300 MB Chromium) cached across ordinary
# releases, since this tiny file changes only when agentic-pi's version does.
#
# ORDERING: a new agentic-pi version must be PUBLISHED to npm before this pin
# can reference its integrity (npm view returns nothing for an unpublished
# version). So on an agentic-pi release: publish first, then regenerate the pin.
#
# A drift guard (tests/agentic-pi-pin.test.ts) asserts — offline — that the pin's
# version matches packages/agentic-pi/package.json, so a forgotten regeneration
# fails CI rather than silently installing a stale agentic-pi.
#
# Usage:
#   scripts/agentic-pi-pin.sh            # regenerate sandbox/agentic-pi.pin (needs network: npm view)
#   scripts/agentic-pi-pin.sh --check    # exit non-zero if it's out of date (needs network)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The single pnpm-lock.yaml lives at the WORKSPACE root (the monorepo root) —
# walk upward until we find it, so the script keeps working if the package ever
# moves again. agentic-pi's package.json is resolved relative to that root.
WORKSPACE_ROOT="$ROOT"
while [ ! -f "$WORKSPACE_ROOT/pnpm-lock.yaml" ]; do
  parent="$(dirname "$WORKSPACE_ROOT")"
  if [ "$parent" = "$WORKSPACE_ROOT" ]; then
    echo "pnpm-lock.yaml not found above $ROOT" >&2
    exit 1
  fi
  WORKSPACE_ROOT="$parent"
done
PKG_JSON="$WORKSPACE_ROOT/packages/agentic-pi/package.json"
PIN="$ROOT/sandbox/agentic-pi.pin"

pin_from_registry() {
  if [ ! -f "$PKG_JSON" ]; then
    echo "$PKG_JSON not found — is agentic-pi still a workspace package?" >&2
    exit 1
  fi
  local version integrity
  version="$(node -e "process.stdout.write(require('$PKG_JSON').version)")"
  # npm reports the tarball's Subresource-Integrity string (sha512-<base64>) —
  # exactly what the Dockerfile recomputes from the downloaded .tgz and compares.
  integrity="$(npm view "agentic-pi@${version}" dist.integrity 2>/dev/null || true)"
  if [ -z "$integrity" ]; then
    echo "npm has no dist.integrity for agentic-pi@${version} — publish it first, then regenerate the pin" >&2
    exit 1
  fi
  printf '%s\n%s\n' "$version" "$integrity"
}

expected="$(pin_from_registry)"

if [ "${1:-}" = "--check" ]; then
  if [ ! -f "$PIN" ] || [ "$(cat "$PIN")" != "$expected" ]; then
    echo "sandbox/agentic-pi.pin is out of date — run scripts/agentic-pi-pin.sh" >&2
    exit 1
  fi
  echo "sandbox/agentic-pi.pin is up to date"
  exit 0
fi

mkdir -p "$ROOT/sandbox"
printf '%s\n' "$expected" > "$PIN"
echo "Wrote $PIN:"
cat "$PIN"
