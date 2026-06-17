import { describe, it, expect } from "vitest";
import {
  ALLOW_ALL_SENTINEL,
  DEFAULT_ALLOWLIST,
  GITHUB_HOSTS,
  PACKAGE_REGISTRY_HOSTS,
  PROVIDER_HOSTS,
  collectorHostsFromOtelEnv,
  mergeAllowlist,
  normalizeAllowlistHost,
} from "./egress-allowlist.js";

describe("egress-allowlist source of truth", () => {
  it("groups are non-empty and disjoint", () => {
    for (const group of [GITHUB_HOSTS, PROVIDER_HOSTS, PACKAGE_REGISTRY_HOSTS]) {
      expect(group.length).toBeGreaterThan(0);
    }
    const all = [...GITHUB_HOSTS, ...PROVIDER_HOSTS, ...PACKAGE_REGISTRY_HOSTS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("DEFAULT_ALLOWLIST is the union of the three groups in declaration order", () => {
    const expected = [...GITHUB_HOSTS, ...PROVIDER_HOSTS, ...PACKAGE_REGISTRY_HOSTS];
    expect([...DEFAULT_ALLOWLIST]).toEqual(expected);
  });

  it("covers the critical host categories the runtime depends on", () => {
    // GitHub apex covers api.github.com, codeload.github.com, raw.…
    expect(GITHUB_HOSTS).toContain("github.com");
    // Provider hosts — the docker backend dials these from inside the
    // sandbox container.
    expect(PROVIDER_HOSTS).toContain("openai.com");
    expect(PROVIDER_HOSTS).toContain("anthropic.com");
    // npm — covers registry.npmjs.org, auth.npmjs.org, www.npmjs.org.
    expect(PACKAGE_REGISTRY_HOSTS).toContain("npmjs.org");
  });

  it("entries are bare hostnames (no leading dot, no wildcard prefix)", () => {
    // Convention is "every entry matches apex+subdomains" — see file
    // docstring. The config generator emits the right syntax for each
    // backend. If someone tries to write `.github.com` or `*.github.com`
    // here, fail fast.
    for (const host of DEFAULT_ALLOWLIST) {
      expect(host).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/);
      expect(host.startsWith(".")).toBe(false);
      expect(host.includes("*")).toBe(false);
    }
  });

  it("ALLOW_ALL_SENTINEL is the wildcard string the gondolin matcher honours", () => {
    expect(ALLOW_ALL_SENTINEL).toBe("*");
  });

  it("normalizes and merges extra allowlist hosts", () => {
    expect(normalizeAllowlistHost("https://Collector.Example.com:4318/v1/traces")).toBe("collector.example.com");
    expect(normalizeAllowlistHost("169.254.169.254")).toBeNull();
    expect(mergeAllowlist(["github.com"], ["GitHub.com", "otel.example.com"])).toEqual([
      "github.com",
      "otel.example.com",
    ]);
  });

  it("derives collector hosts from OTEL endpoint env vars", () => {
    expect(collectorHostsFromOtelEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://traces.example.com/v1/traces",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "not a url.example.org/path",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://169.254.169.254/latest/meta-data",
    })).toEqual(["otel.example.com", "traces.example.com", "not a url.example.org"]);
  });
});
