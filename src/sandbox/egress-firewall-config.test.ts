import { describe, it, expect } from "vitest";
import {
  COREDNS_OPEN_IP,
  COREDNS_STRICT_IP,
  NGINX_OPEN_IP,
  NGINX_STRICT_IP,
  OTEL_COLLECTOR_IP,
  OTEL_COLLECTOR_OTLP_GRPC_PORT,
  OTEL_COLLECTOR_OTLP_HTTP_PORT,
  OTEL_COLLECTOR_SANDBOX_ENDPOINT,
  renderCorefileOpen,
  renderCorefileStrict,
  renderNginxOpenConf,
  renderNginxStrictConf,
  renderOtelCollectorConfig,
  SANDBOX_EGRESS_SUBNET,
} from "./egress-firewall-config.js";
import { DEFAULT_ALLOWLIST } from "./egress-allowlist.js";
import { parse as parseYaml } from "yaml";

describe("static IP constants", () => {
  it("all four service IPs sit inside the sandbox-egress subnet", () => {
    const prefix = SANDBOX_EGRESS_SUBNET.split("/")[0].split(".").slice(0, 3).join(".");
    for (const ip of [COREDNS_STRICT_IP, COREDNS_OPEN_IP, NGINX_STRICT_IP, NGINX_OPEN_IP]) {
      expect(ip.startsWith(prefix + ".")).toBe(true);
    }
  });

  it("strict and open IPs are distinct in both pairs", () => {
    expect(COREDNS_STRICT_IP).not.toBe(COREDNS_OPEN_IP);
    expect(NGINX_STRICT_IP).not.toBe(NGINX_OPEN_IP);
  });
});

describe("nginx strict config", () => {
  const conf = renderNginxStrictConf();

  it("listens on 443 with ssl_preread enabled", () => {
    expect(conf).toMatch(/listen\s+443;/);
    expect(conf).toMatch(/ssl_preread\s+on;/);
  });

  it("defaults unknown SNIs to a black-hole upstream (instant reset)", () => {
    expect(conf).toMatch(/default\s+127\.0\.0\.1:1;/);
  });

  it("emits a leading-dot map entry per allowlist host (apex+subdomain match)", () => {
    for (const host of DEFAULT_ALLOWLIST) {
      // nginx's `.foo.com` syntax matches `foo.com` and any subdomain.
      // Upstream is the live SNI value, not pinned at config time.
      expect(conf).toContain(`.${host} $ssl_preread_server_name:443;`);
    }
  });

  it("uses docker's embedded DNS as the upstream resolver", () => {
    expect(conf).toMatch(/resolver\s+127\.0\.0\.11/);
  });

  it("declares `hostnames` in the map block so leading-dot wildcards work", () => {
    // Without `hostnames;`, nginx's `map` does exact string match only —
    // `.github.com` becomes a literal key that never matches anything.
    // We hit this in prod: every allowlisted host fell through to the
    // black-hole default. Pin the contract so it can't regress.
    expect(conf).toMatch(/map\s+\$ssl_preread_server_name\s+\$upstream_target\s*\{\s*\n\s*hostnames;/);
  });

  it("includes extra collector hosts in the strict allowlist", () => {
    const withCollector = renderNginxStrictConf(["otel.example.com"]);
    expect(withCollector).toContain(".otel.example.com $ssl_preread_server_name:443;");
  });
});

describe("nginx open config", () => {
  const conf = renderNginxOpenConf();

  it("tunnels whatever SNI was sent — no allowlist map", () => {
    expect(conf).toMatch(/proxy_pass\s+\$ssl_preread_server_name:443;/);
    expect(conf).not.toMatch(/map\s+\$ssl_preread_server_name/);
  });

  it("still listens on 443 with ssl_preread enabled", () => {
    expect(conf).toMatch(/listen\s+443;/);
    expect(conf).toMatch(/ssl_preread\s+on;/);
  });
});

describe("coredns strict Corefile", () => {
  const conf = renderCorefileStrict();

  it("uses a SINGLE template block with one match line per allowlist host", () => {
    // CoreDNS only honours one `template` block per (class, type, zone) —
    // multiple blocks silently shadow each other. Catching a regression
    // matters because we hit this exact bug in prod.
    const templateBlocks = conf.match(/template\s+IN\s+A\s*\{/g) || [];
    expect(templateBlocks.length).toBe(1);

    for (const host of DEFAULT_ALLOWLIST) {
      const escaped = host.replaceAll(".", "\\.");
      expect(conf).toContain(`(^|\\.)${escaped}\\.$`);
    }
  });

  it("answers with the nginx-strict IP", () => {
    expect(conf).toContain(`IN A ${NGINX_STRICT_IP}`);
  });

  it("catches every unmatched query with an NXDOMAIN template", () => {
    expect(conf).toMatch(/template\s+IN\s+ANY\s*\{[\s\S]*rcode\s+NXDOMAIN[\s\S]*\}/);
  });

  it("includes extra collector hosts in strict CoreDNS matches", () => {
    expect(renderCorefileStrict(["otel.example.com"])).toContain("(^|\\.)otel\\.example\\.com\\.$");
  });
});

describe("coredns open Corefile", () => {
  const conf = renderCorefileOpen();

  it("returns the nginx-open IP for arbitrary A queries", () => {
    expect(conf).toContain(`IN A ${NGINX_OPEN_IP}`);
  });

  it("hard-denies cloud metadata literals even in unrestricted mode", () => {
    // Each hard-deny host gets its own zone block so CoreDNS's
    // longest-suffix routing intercepts the apex + subdomains before
    // the catch-all `.` zone sees them.
    expect(conf).toMatch(/metadata\.google\.internal:53\s*\{[\s\S]*?rcode\s+NXDOMAIN/);
    expect(conf).toMatch(/169\.254\.169\.254:53\s*\{[\s\S]*?rcode\s+NXDOMAIN/);
  });

  it("returns NOERROR / empty for AAAA so IPv6 doesn't accidentally bypass us", () => {
    expect(conf).toMatch(/template\s+IN\s+AAAA\s*\{[\s\S]*rcode\s+NOERROR[\s\S]*\}/);
  });
});

describe("otel collector config", () => {
  it("sandbox endpoint points at the collector's static IP + OTLP/HTTP port", () => {
    expect(OTEL_COLLECTOR_SANDBOX_ENDPOINT).toBe(`http://${OTEL_COLLECTOR_IP}:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`);
  });

  it("receives OTLP on both http and grpc, on all interfaces", () => {
    const cfg = parseYaml(renderOtelCollectorConfig({})) as any;
    expect(cfg.receivers.otlp.protocols.http.endpoint).toBe(`0.0.0.0:${OTEL_COLLECTOR_OTLP_HTTP_PORT}`);
    expect(cfg.receivers.otlp.protocols.grpc.endpoint).toBe(`0.0.0.0:${OTEL_COLLECTOR_OTLP_GRPC_PORT}`);
  });

  it("re-exports to the configured backend endpoint with parsed auth headers", () => {
    const cfg = parseYaml(renderOtelCollectorConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=secret-123,x-tenant=acme",
    })) as any;
    const exp = cfg.exporters["otlphttp/backend"];
    expect(exp.endpoint).toBe("https://collector.example.com:4318");
    expect(exp.headers).toEqual({ "api-key": "secret-123", "x-tenant": "acme" });
    // Every pipeline forwards to the backend exporter.
    for (const signal of ["traces", "metrics", "logs"]) {
      expect(cfg.service.pipelines[signal].exporters).toEqual(["otlphttp/backend"]);
    }
  });

  it("supports a non-443 / custom-port HTTPS backend the strict SNI firewall could not reach", () => {
    // This is the case the reviewer flagged for the old direct-forward path.
    // It now works because the collector dials the backend on its trusted
    // outbound leg, not through ssl_preread.
    const cfg = parseYaml(renderOtelCollectorConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.internal:4318",
    })) as any;
    expect(cfg.exporters["otlphttp/backend"].endpoint).toBe("https://otel.internal:4318");
  });

  it("preserves '=' inside header values (bearer tokens survive intact)", () => {
    const cfg = parseYaml(renderOtelCollectorConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://b.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc=def==",
    })) as any;
    expect(cfg.exporters["otlphttp/backend"].headers.authorization).toBe("Bearer abc=def==");
  });

  it("falls back to a debug exporter (no data leaves) when no backend is configured", () => {
    const cfg = parseYaml(renderOtelCollectorConfig({})) as any;
    expect(cfg.exporters.debug).toBeDefined();
    expect(cfg.exporters["otlphttp/backend"]).toBeUndefined();
    for (const signal of ["traces", "metrics", "logs"]) {
      expect(cfg.service.pipelines[signal].exporters).toEqual(["debug"]);
    }
  });

  it("produces valid YAML even with quote/backslash-bearing header values", () => {
    // Crucially, a single quote in a header value no longer fails anything:
    // it lives in the host-side collector config, never a sandbox shell wrap.
    const cfg = parseYaml(renderOtelCollectorConfig({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://b.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: `x-quote=it's "quoted" \\ backslash`,
    })) as any;
    expect(cfg.exporters["otlphttp/backend"].headers["x-quote"]).toBe(`it's "quoted" \\ backslash`);
  });
});

describe("apex + subdomain match sanity", () => {
  // Pin behaviour: a bare entry like "github.com" must match both
  // the apex and any subdomain in both backends.

  it("'github.com' generates an nginx leading-dot map entry", () => {
    const conf = renderNginxStrictConf();
    expect(conf).toMatch(/\s\.github\.com\s+\$ssl_preread_server_name:443;/);
  });

  it("'github.com' generates a CoreDNS pattern matching apex + subdomains", () => {
    const conf = renderCorefileStrict();
    // (^|\.)github\.com\.$ matches both "github.com." and "api.github.com."
    // in FQDN-with-trailing-dot form.
    expect(conf).toContain("(^|\\.)github\\.com\\.$");
  });
});
