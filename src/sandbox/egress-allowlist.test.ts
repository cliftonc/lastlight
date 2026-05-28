import { describe, it, expect } from "vitest";
import {
  ALLOW_ALL_SENTINEL,
  DEFAULT_ALLOWLIST,
  GITHUB_HOSTS,
  isWildcardHost,
  PACKAGE_REGISTRY_HOSTS,
  PROVIDER_HOSTS,
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
    // Wildcard `.github.com` covers api.github.com, codeload.github.com, etc.
    expect(GITHUB_HOSTS).toContain(".github.com");
    // Provider hosts — the docker backend dials these from inside the
    // sandbox container. Wildcarded so auth/docs/api subdomains all match.
    expect(PROVIDER_HOSTS).toContain(".anthropic.com");
    expect(PROVIDER_HOSTS).toContain(".openai.com");
    // npm — agentic-pi-dev image runs `npm install` for many phases.
    // Wildcard covers registry, auth, and www subdomains.
    expect(PACKAGE_REGISTRY_HOSTS).toContain(".npmjs.org");
  });

  it("every package-registry and provider entry is a wildcard", () => {
    // Defense against accidental tightening to exact match — wildcards
    // are the chosen default for registries (auth/CDN subdomains) and
    // providers (docs/console subdomains). Add new exact-match entries
    // here only deliberately.
    for (const host of [...PROVIDER_HOSTS, ...PACKAGE_REGISTRY_HOSTS]) {
      expect(isWildcardHost(host)).toBe(true);
    }
  });

  it("rejects accidental whitespace or empty entries", () => {
    // Wildcard entries are allowed to start with `.`; everything else
    // must look like a normal hostname.
    for (const host of DEFAULT_ALLOWLIST) {
      expect(host).toMatch(/^\.?[A-Za-z0-9][A-Za-z0-9.-]*$/);
    }
  });

  it("isWildcardHost recognises only the leading-dot form", () => {
    expect(isWildcardHost(".github.com")).toBe(true);
    expect(isWildcardHost("api.openai.com")).toBe(false);
    expect(isWildcardHost("")).toBe(false);
  });

  it("ALLOW_ALL_SENTINEL is the wildcard string the gondolin matcher honours", () => {
    expect(ALLOW_ALL_SENTINEL).toBe("*");
  });
});
