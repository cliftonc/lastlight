#!/bin/sh
# Wait for the lastlight harness to write the config, then exec tinyproxy.
# Configs live under $STATE_DIR/proxy/ on the host and are bind-mounted to
# /etc/tinyproxy/ inside this container by docker-compose.yml. They are
# (re)generated on every harness boot from src/sandbox/egress-allowlist.ts.
set -eu

CONF="${TINYPROXY_CONF:-/etc/tinyproxy/tinyproxy.conf}"

# Wait up to ~10 minutes for the harness to come up and write the file.
# After that, give up and let docker-compose restart the container —
# clearer signal than spinning forever.
WAIT_LIMIT="${WAIT_LIMIT_SECONDS:-600}"
elapsed=0
while [ ! -f "$CONF" ]; do
  if [ "$elapsed" -ge "$WAIT_LIMIT" ]; then
    echo "tinyproxy-entrypoint: gave up waiting for $CONF after ${WAIT_LIMIT}s" >&2
    exit 1
  fi
  if [ "$((elapsed % 30))" = 0 ]; then
    echo "tinyproxy-entrypoint: waiting for $CONF…"
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "tinyproxy-entrypoint: starting tinyproxy with $CONF"
exec tinyproxy -d -c "$CONF"
