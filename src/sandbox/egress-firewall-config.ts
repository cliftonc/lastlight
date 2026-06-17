import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_ALLOWLIST, mergeAllowlist } from "./egress-allowlist.js";

/**
 * Egress firewall config generation for the docker sandbox backend.
 *
 * Architecture (replaces the earlier tinyproxy CONNECT-proxy):
 *
 *   sandbox-egress (internal: true, subnet 172.30.0.0/24)
 *     ├─ sandbox containers              (docker run --dns <coredns-ip>)
 *     ├─ coredns-strict   172.30.0.10    → returns nginx-strict IP for allowlist hosts, NXDOMAIN otherwise
 *     ├─ coredns-open     172.30.0.11    → returns nginx-open IP for ANY hostname (except hard-deny SSRF magnets)
 *     ├─ nginx-egress-strict 172.30.0.20 → ssl_preread, SNI must match allowlist; tunnel upstream via proxy-egress
 *     └─ nginx-egress-open   172.30.0.21 → tunnel any SNI; client DNS already gated through coredns-open
 *
 * Why this instead of a forward proxy (tinyproxy/smokescreen): clients
 * inside the sandbox (especially the OpenAI/Anthropic SDKs that build
 * their own undici dispatchers) don't honour HTTP_PROXY / HTTPS_PROXY.
 * Forcing them to cooperate is a losing battle. By spoofing DNS and
 * peeking SNI at the network layer, the sandbox sees no proxy at all —
 * it dials `api.openai.com:443` directly. The firewall intercepts the
 * connection by virtue of being the only thing the spoofed DNS pointed
 * at.
 *
 * Inspired by Vercel Sandbox's egress firewall (SNI peeking, no env
 * vars). Their implementation also handles TLS termination for
 * credentials brokering and Postgres STARTTLS — we don't (yet).
 *
 * ## Wildcards
 *
 * Entries in egress-allowlist.ts with a leading dot (`".github.com"`)
 * match the apex plus every subdomain. nginx's `map` directive supports
 * this syntax natively. CoreDNS uses the `template` plugin with an
 * anchored regex to do the same.
 */

/** Fixed IPs assigned in docker-compose.yml so `--dns` and nginx upstreams can reference them. */
export const COREDNS_STRICT_IP = "172.30.0.10";
export const COREDNS_OPEN_IP = "172.30.0.11";
export const NGINX_STRICT_IP = "172.30.0.20";
export const NGINX_OPEN_IP = "172.30.0.21";

/**
 * Static IP of the in-network OTEL collector (docker backend). Sandboxes
 * dial it directly by IP — it lives on `sandbox-egress` alongside the
 * firewalls, so no DNS lookup (and therefore no coredns allowlist entry)
 * is involved. The collector is the ONLY OTLP endpoint a sandbox ever
 * sees: it terminates the sandbox's telemetry and re-exports to the real
 * backend over `proxy-egress` using credentials that stay host-side. This
 * is why the strict SNI firewall no longer needs to know about collector
 * hosts or non-443 ports — that hop happens on the trusted outbound leg,
 * not through `ssl_preread`.
 */
export const OTEL_COLLECTOR_IP = "172.30.0.30";
/** OTLP/HTTP + OTLP/gRPC receiver ports the in-network collector listens on. */
export const OTEL_COLLECTOR_OTLP_HTTP_PORT = 4318;
export const OTEL_COLLECTOR_OTLP_GRPC_PORT = 4317;
/** Endpoint a docker sandbox is told to export OTLP to (HTTP/protobuf). */
export const OTEL_COLLECTOR_SANDBOX_ENDPOINT = `http://${OTEL_COLLECTOR_IP}:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`;

/** Subnet for sandbox-egress. Compose declares this CIDR so the IPs above are valid. */
export const SANDBOX_EGRESS_SUBNET = "172.30.0.0/24";

/**
 * Hostnames the open coredns explicitly NXDOMAINs even in unrestricted
 * mode — known SSRF magnets. nginx's `ssl_preread` SNI inspection alone
 * can't catch hostnames that resolve to private IPs (the DNS server
 * we control gets the first say), so this is the right layer to enforce
 * "no cloud metadata, no internal services" even with `unrestricted_egress`.
 */
const OPEN_MODE_HARD_DENY: readonly string[] = [
  "metadata.google.internal",
  "169.254.169.254", // GCP / AWS / Azure metadata service IP literal
];

/**
 * Convert one allowlist entry to its nginx `map` line.
 *
 *   "openai.com" → '.openai.com  $ssl_preread_server_name:443;'
 *
 * Every entry is treated as apex+subdomain (see egress-allowlist.ts).
 * The generated line uses nginx's `.foo.com` leading-dot syntax,
 * which is its built-in "match this domain and all subdomains" form.
 * Upstream is whatever SNI the client sent — we don't know which
 * subdomain they're targeting at config-gen time.
 */
function nginxMapLine(entry: string): string {
  return `        .${entry} $ssl_preread_server_name:443;`;
}

/**
 * Build one CoreDNS `match` regex per allowlist entry. All entries
 * share a SINGLE `template` block (see renderCorefileStrict) because
 * CoreDNS only honours one `template` per zone — multiple blocks
 * silently shadow each other.
 *
 * The `(^|\.)` prefix matches the apex (`openai.com.`) or any subdomain
 * (`api.openai.com.`) — same semantics as nginx's leading-dot form.
 */
function corednsMatchLineForEntry(entry: string): string {
  const escapedHost = entry.replaceAll(".", "\\.");
  return `        match (^|\\.)${escapedHost}\\.$`;
}

/** Build the strict nginx.conf — ssl_preread + map on SNI allowlist. */
export function renderNginxStrictConf(extraAllowlistHosts: readonly string[] = []): string {
  const mapLines = mergeAllowlist(DEFAULT_ALLOWLIST, extraAllowlistHosts).map(nginxMapLine).join("\n");
  return `# Generated by lastlight at harness boot. DO NOT EDIT BY HAND —
# source of truth is src/sandbox/egress-allowlist.ts.

error_log /dev/stderr warn;
pid /tmp/nginx.pid;

events { worker_connections 1024; }

# Streams (TCP/UDP). \`ssl_preread\` reads the TLS ClientHello without
# terminating the session, exposing the SNI hostname as
# \`$ssl_preread_server_name\`. We \`map\` that to an upstream — anything
# unmatched is sunk to 127.0.0.1:1 (no listener, instant reset).
stream {
  log_format basic '$remote_addr -> $ssl_preread_server_name -> $upstream_addr status=$status';
  access_log /dev/stdout basic;

  # Runtime resolver for upstream hostnames (docker's embedded DNS).
  resolver 127.0.0.11 valid=30s ipv6=off;

  # Allowlist. The \`hostnames\` directive enables nginx's wildcard
  # hostname match: a key like ".github.com" matches "github.com" AND
  # any subdomain. WITHOUT \`hostnames\`, map does exact string match
  # only and ".github.com" never matches anything real (we hit this
  # exact bug in prod — every allowlisted host fell through to the
  # black hole).
  map $ssl_preread_server_name $upstream_target {
    hostnames;
${mapLines}
    # Anything else → black hole. The connection resets immediately;
    # no data ever leaves the sandbox-egress network.
    default 127.0.0.1:1;
  }

  server {
    listen 443;
    ssl_preread on;
    proxy_pass $upstream_target;
    proxy_connect_timeout 5s;
    proxy_timeout 60s;
  }
}
`;
}

/** Build the open nginx.conf — no SNI allowlist, just tunnel whatever DNS pointed at. */
export function renderNginxOpenConf(): string {
  return `# Generated by lastlight at harness boot. DO NOT EDIT BY HAND.
# This nginx is used only by phases that declared \`unrestricted_egress: true\`.
# No SNI allowlist — every host is tunnelled. The corresponding coredns-open
# refuses to resolve the cloud-metadata hostnames so SSRF to them is blocked
# even in this mode.

error_log /dev/stderr warn;
pid /tmp/nginx.pid;

events { worker_connections 1024; }

stream {
  log_format basic '$remote_addr -> $ssl_preread_server_name -> $upstream_addr status=$status';
  access_log /dev/stdout basic;
  resolver 127.0.0.11 valid=30s ipv6=off;

  server {
    listen 443;
    ssl_preread on;
    # $ssl_preread_server_name is whatever SNI the client sent. Tunnel
    # to that hostname on :443. No allowlist check.
    proxy_pass $ssl_preread_server_name:443;
    proxy_connect_timeout 5s;
    proxy_timeout 60s;
  }
}
`;
}

/** Build the Corefile that returns the strict nginx IP for allowlist hosts. */
export function renderCorefileStrict(extraAllowlistHosts: readonly string[] = []): string {
  // ALL allowlist entries share a SINGLE template block. CoreDNS only
  // honours one `template` per (class, type, zone), so multiple blocks
  // silently overwrite each other — we learned this in prod when only
  // the first host in the list resolved.
  const matchLines = mergeAllowlist(DEFAULT_ALLOWLIST, extraAllowlistHosts).map(corednsMatchLineForEntry).join("\n");
  return `# Generated by lastlight from src/sandbox/egress-allowlist.ts.
# All allowlist hosts live in a single \`template IN A\` block (multiple
# template blocks per zone are NOT additive — they shadow each other).
# Queries that don't match any \`match\` regex fall through to the
# catch-all NXDOMAIN at the end.
.:53 {
    template IN A {
${matchLines}
        answer "{{ .Name }} 60 IN A ${NGINX_STRICT_IP}"
    }
    # Catch-all: NXDOMAIN for everything else (including AAAA queries,
    # since nginx-egress only binds 443 on IPv4).
    template IN ANY {
        rcode NXDOMAIN
    }
    errors
    log
}
`;
}

/** Build the Corefile that returns the open nginx IP for ANY hostname (except hard-denies). */
export function renderCorefileOpen(): string {
  // Hard-deny hosts each get their OWN zone block. CoreDNS routes queries
  // to the longest-suffix-matching zone, so `metadata.google.internal:53`
  // catches both the apex and every subdomain before the catch-all `.`
  // zone ever sees them. We do NOT use a multi-`template` layout inside
  // the catch-all zone because CoreDNS only honours one template per
  // (class, type) and prior templates with non-matching `match` clauses
  // silently drop the query — leaving sandboxes with no DNS answer at
  // all (which is exactly what failed in prod the first time explore
  // ran on the open path).
  const hardDenyZones = OPEN_MODE_HARD_DENY.map(
    (host) => `# Hard-deny zone for ${host} (SSRF floor — NXDOMAIN even in unrestricted mode).
${host}:53 {
    template IN ANY {
        rcode NXDOMAIN
    }
    errors
    log
}
`,
  ).join("\n");
  return `# Generated by lastlight. Used by sandbox phases with unrestricted_egress: true.
# Returns nginx-egress-open's IP for every hostname EXCEPT the SSRF hard-denies
# (cloud metadata literals etc).
.:53 {
    # Everything → nginx-egress-open IP. Hard-deny names are intercepted
    # by the per-host zones declared below (longest-suffix zone match).
    template IN A {
        answer "{{ .Name }} 60 IN A ${NGINX_OPEN_IP}"
    }
    # AAAA returns empty (we route only via IPv4).
    template IN AAAA {
        rcode NOERROR
    }
    errors
    log
}

${hardDenyZones}`;
}

/**
 * Write the four config files under $STATE_DIR/proxy/. Idempotent.
 * Returns the directory path. Compose bind-mounts this dir into the
 * coredns + nginx containers read-only.
 */
export function writeEgressFirewallConfigs(stateDir: string, extraAllowlistHosts: readonly string[] = []): string {
  const dir = join(stateDir, "proxy");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "nginx-strict.conf"), renderNginxStrictConf(extraAllowlistHosts));
  writeFileSync(join(dir, "nginx-open.conf"), renderNginxOpenConf());
  writeFileSync(join(dir, "Corefile.strict"), renderCorefileStrict(extraAllowlistHosts));
  writeFileSync(join(dir, "Corefile.open"), renderCorefileOpen());
  return dir;
}

/**
 * Parse an OTLP headers string (`key1=val1,key2=val2`, the OTEL spec format
 * used by `OTEL_EXPORTER_OTLP_HEADERS`) into an ordered list of pairs.
 * Malformed segments (no `=`, empty key) are dropped. Values keep any inner
 * `=` so bearer tokens survive intact.
 */
function parseOtlpHeaders(raw: string | undefined): Array<[string, string]> {
  if (!raw) return [];
  const out: Array<[string, string]> = [];
  for (const segment of raw.split(",")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (key) out.push([key, value]);
  }
  return out;
}

/** YAML double-quoted-scalar escape (covers the cases that appear in tokens/URLs). */
function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render the in-network OTEL collector config (docker backend).
 *
 * The collector receives OTLP from sandboxes (which only know its internal
 * IP) and re-exports to the REAL backend — `OTEL_EXPORTER_OTLP_ENDPOINT`
 * and `OTEL_EXPORTER_OTLP_HEADERS` as configured on the harness. Those
 * credentials live here, in a file on the host mounted read-only into the
 * collector, and are NEVER forwarded into an untrusted sandbox. The
 * sandbox can only influence span *content* sent to the harness's own
 * fixed backend — it cannot redirect where the collector exports, so this
 * adds no SSRF/exfil surface.
 *
 * When no backend endpoint is configured, the collector wires a `debug`
 * exporter (drops data) so it still boots cleanly and accepts connections
 * — sandboxes that aren't given the endpoint simply never connect.
 */
export function renderOtelCollectorConfig(env: NodeJS.ProcessEnv = process.env): string {
  const backend = (
    env.OTEL_EXPORTER_OTLP_ENDPOINT
    || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    || ""
  ).trim();
  const headers = parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS);
  const hasBackend = backend.length > 0;
  const exporterName = hasBackend ? "otlphttp/backend" : "debug";

  const exportersBlock = hasBackend
    ? `  otlphttp/backend:
    endpoint: ${yamlQuote(backend)}${headers.length
        ? `
    headers:
${headers.map(([k, v]) => `      ${yamlQuote(k)}: ${yamlQuote(v)}`).join("\n")}`
        : ""}`
    : `  debug:
    verbosity: normal`;

  const pipeline = (signal: string) => `    ${signal}:
      receivers: [otlp]
      processors: [batch]
      exporters: [${exporterName}]`;

  return `# Generated by lastlight at harness boot. DO NOT EDIT BY HAND —
# source of truth is src/sandbox/egress-firewall-config.ts.
#
# Sandboxes export OTLP to this collector (reached by its internal IP on
# sandbox-egress); the collector re-exports to the configured backend over
# proxy-egress. Backend credentials below stay host-side — they are never
# forwarded into a sandbox.
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:${OTEL_COLLECTOR_OTLP_HTTP_PORT}
      grpc:
        endpoint: 0.0.0.0:${OTEL_COLLECTOR_OTLP_GRPC_PORT}

processors:
  batch: {}

exporters:
${exportersBlock}

service:
  pipelines:
${pipeline("traces")}
${pipeline("metrics")}
${pipeline("logs")}
`;
}

/**
 * Write the in-network collector config to $STATE_DIR/proxy/otel-collector.yaml.
 * Mode 0600 — it can contain backend auth headers. Called at harness boot
 * (and by the compose `egress-init` one-shot) so the file exists before the
 * `otel-collector` service reads it.
 */
export function writeOtelCollectorConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(stateDir, "proxy");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "otel-collector.yaml");
  writeFileSync(path, renderOtelCollectorConfig(env), { mode: 0o600 });
  return path;
}
