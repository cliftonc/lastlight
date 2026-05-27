import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

/**
 * Regression test for the sandbox egress network topology.
 *
 * The threat: an unrestricted sandbox can ask `tinyproxy-open` to fetch
 * compose-internal hostnames (`agent`, `caddy`). If the proxy is on the
 * harness `internal` network, docker DNS resolves those names from the
 * proxy's perspective and the proxy will happily bridge into harness
 * services. The fix is purely topological — the proxies must NOT be on
 * `internal`. This test pins that contract.
 *
 * If you're adding a new compose service that talks to the proxies (or
 * a new proxy), think hard before relaxing these assertions.
 */

interface ComposeService {
  networks?: string[];
}
interface ComposeFile {
  services: Record<string, ComposeService>;
  networks: Record<string, unknown>;
}

const compose: ComposeFile = parse(
  readFileSync(resolve(__dirname, "../../docker-compose.yml"), "utf-8"),
);

const PROXIES = ["tinyproxy-strict", "tinyproxy-open"] as const;
const HARNESS_SERVICES = ["agent", "caddy"] as const;

function networksOf(service: string): string[] {
  return compose.services[service]?.networks ?? [];
}

describe("docker-compose egress topology", () => {
  it("declares the three expected networks", () => {
    expect(Object.keys(compose.networks).sort()).toEqual(
      ["internal", "proxy-egress", "sandbox-egress"].sort(),
    );
  });

  it("marks sandbox-egress as internal: true so sandboxes have no host route", () => {
    const net = compose.networks["sandbox-egress"] as { internal?: boolean };
    expect(net?.internal).toBe(true);
  });

  it("proxy-egress is a regular bridge (no internal: true) so the proxies can reach the internet", () => {
    const net = compose.networks["proxy-egress"] as
      | { internal?: boolean }
      | null
      | undefined;
    // YAML `proxy-egress:` parses to null when no fields are set.
    expect(net == null || net.internal !== true).toBe(true);
  });

  for (const proxy of PROXIES) {
    describe(proxy, () => {
      const nets = networksOf(proxy);

      it("does NOT attach to the harness `internal` network", () => {
        // This is the security-critical assertion. If this regresses, an
        // unrestricted sandbox can proxy to compose-internal services.
        expect(nets).not.toContain("internal");
      });

      it("attaches to sandbox-egress (so sandboxes can reach it)", () => {
        expect(nets).toContain("sandbox-egress");
      });

      it("attaches to proxy-egress (so it can reach the public internet)", () => {
        expect(nets).toContain("proxy-egress");
      });
    });
  }

  for (const svc of HARNESS_SERVICES) {
    it(`harness service \`${svc}\` does NOT attach to proxy-egress (keeps it isolated from proxies)`, () => {
      // The threat model relies on proxy-egress containing only the
      // proxies themselves. Adding a harness service here would re-create
      // the bridge this test is here to prevent.
      expect(networksOf(svc)).not.toContain("proxy-egress");
    });
  }

  it("proxy-egress has no harness services attached (only the proxies)", () => {
    const onProxyEgress = Object.entries(compose.services)
      .filter(([, svc]) => (svc.networks ?? []).includes("proxy-egress"))
      .map(([name]) => name)
      .sort();
    expect(onProxyEgress).toEqual([...PROXIES].sort());
  });
});
