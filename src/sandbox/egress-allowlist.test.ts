import { describe, it, expect } from "vitest";
import {
  ALLOW_ALL_SENTINEL,
  DEFAULT_ALLOWLIST,
  GITHUB_HOSTS,
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
    // api.github.com — required for every github tool call.
    expect(DEFAULT_ALLOWLIST).toContain("api.github.com");
    // Provider host the harness's docker mode hits from inside the container.
    expect(DEFAULT_ALLOWLIST).toContain("api.anthropic.com");
    // npm registry — agentic-pi-dev image runs `npm install` for many phases.
    expect(DEFAULT_ALLOWLIST).toContain("registry.npmjs.org");
  });

  it("rejects accidental whitespace or empty entries", () => {
    for (const host of DEFAULT_ALLOWLIST) {
      expect(host).toMatch(/^[A-Za-z0-9.-]+$/);
    }
  });

  it("ALLOW_ALL_SENTINEL is the wildcard string the gondolin matcher honours", () => {
    expect(ALLOW_ALL_SENTINEL).toBe("*");
  });
});
