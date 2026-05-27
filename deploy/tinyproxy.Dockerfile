# Tinyproxy sidecar used by the docker sandbox backend to gate sandbox HTTP
# egress against the lastlight allowlist. Two copies of this image run side
# by side (tinyproxy-strict / tinyproxy-open) — see docker-compose.yml.
#
# The config file is bind-mounted from $STATE_DIR/proxy/<name>.conf, which
# the harness regenerates at boot from src/sandbox/egress-allowlist.ts.
# Because the harness and the proxies start in parallel, the entrypoint
# waits for the config to appear before exec'ing tinyproxy.
FROM alpine:3.20

RUN apk add --no-cache tinyproxy

COPY tinyproxy-entrypoint.sh /usr/local/bin/tinyproxy-entrypoint.sh
RUN chmod +x /usr/local/bin/tinyproxy-entrypoint.sh

ENV TINYPROXY_CONF=/etc/tinyproxy/tinyproxy.conf

EXPOSE 8888

ENTRYPOINT ["/usr/local/bin/tinyproxy-entrypoint.sh"]
