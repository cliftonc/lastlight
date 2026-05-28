import { describe, it, expect } from "vitest";
import {
  COREDNS_OPEN_IP,
  COREDNS_STRICT_IP,
  NGINX_OPEN_IP,
  NGINX_STRICT_IP,
  renderCorefileOpen,
  renderCorefileStrict,
  renderNginxOpenConf,
  renderNginxStrictConf,
  SANDBOX_EGRESS_SUBNET,
} from "./egress-firewall-config.js";
import { DEFAULT_ALLOWLIST } from "./egress-allowlist.js";

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
});

describe("coredns open Corefile", () => {
  const conf = renderCorefileOpen();

  it("returns the nginx-open IP for arbitrary A queries", () => {
    expect(conf).toContain(`IN A ${NGINX_OPEN_IP}`);
  });

  it("hard-denies cloud metadata literals even in unrestricted mode", () => {
    expect(conf).toContain("metadata\\.google\\.internal");
    expect(conf).toContain("169\\.254\\.169\\.254");
    expect(conf).toMatch(/rcode\s+NXDOMAIN/);
  });

  it("returns NOERROR / empty for AAAA so IPv6 doesn't accidentally bypass us", () => {
    expect(conf).toMatch(/template\s+IN\s+AAAA\s*\{[\s\S]*rcode\s+NOERROR[\s\S]*\}/);
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
