import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderFilterList,
  renderOpenConf,
  renderStrictConf,
  TINYPROXY_PORT,
} from "./tinyproxy-config.js";
import { DEFAULT_ALLOWLIST } from "./egress-allowlist.js";

describe("tinyproxy strict config", () => {
  const conf = renderStrictConf({ blockPrivateIps: true });

  it("listens on the published port", () => {
    expect(conf).toMatch(new RegExp(`^Port ${TINYPROXY_PORT}$`, "m"));
  });

  it("denies private address ranges when the toggle is on", () => {
    for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"]) {
      expect(conf).toContain(`Deny ${cidr}`);
    }
  });

  it("locks CONNECT to port 443 so the agent can't tunnel other services", () => {
    expect(conf).toMatch(/^ConnectPort 443$/m);
  });

  it("enables the destination filter (FilterDefaultDeny + Filter directive)", () => {
    expect(conf).toMatch(/^FilterDefaultDeny\s+Yes$/m);
    expect(conf).toMatch(/^Filter\s+".*filter\.txt"$/m);
  });

  it("omits private-IP denies when the toggle is off", () => {
    const off = renderStrictConf({ blockPrivateIps: false });
    expect(off).not.toContain("Deny 10.0.0.0/8");
    expect(off).toContain("Private-IP blocking disabled");
  });
});

describe("tinyproxy open config", () => {
  const conf = renderOpenConf({ blockPrivateIps: true });

  it("has no destination Filter directive", () => {
    expect(conf).not.toMatch(/^Filter\s+"/m);
    expect(conf).not.toMatch(/^FilterDefaultDeny\s+Yes$/m);
  });

  it("still applies the private-IP floor when the toggle is on", () => {
    expect(conf).toContain("Deny 10.0.0.0/8");
    expect(conf).toContain("Deny 127.0.0.0/8");
  });

  it("drops the private-IP floor when the toggle is off", () => {
    const off = renderOpenConf({ blockPrivateIps: false });
    expect(off).not.toContain("Deny 10.0.0.0/8");
    expect(off).toContain("Private-IP blocking disabled");
  });
});

describe("tinyproxy filter list", () => {
  const text = renderFilterList();

  it("emits one regex per allowlisted host", () => {
    for (const host of DEFAULT_ALLOWLIST) {
      const escaped = host.replaceAll(".", "\\.");
      expect(text).toContain(`(^|\\.)${escaped}$`);
    }
  });

  it("anchors each pattern at end-of-host to block suffix-confusion attacks", () => {
    // A bare 'api.github.com' must NOT match 'api.github.com.evil.example.com'.
    // The anchored regex form `$` enforces this.
    const lines = text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      expect(line.endsWith("$")).toBe(true);
    }
  });
});

describe("LASTLIGHT_BLOCK_PRIVATE_IPS env toggle", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.LASTLIGHT_BLOCK_PRIVATE_IPS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LASTLIGHT_BLOCK_PRIVATE_IPS;
    else process.env.LASTLIGHT_BLOCK_PRIVATE_IPS = original;
  });

  it("treats unset as enabled", () => {
    delete process.env.LASTLIGHT_BLOCK_PRIVATE_IPS;
    expect(renderStrictConf()).toContain("Deny 10.0.0.0/8");
  });

  it("treats 0/false/no as disabled", () => {
    for (const value of ["0", "false", "no", "FALSE"]) {
      process.env.LASTLIGHT_BLOCK_PRIVATE_IPS = value;
      expect(renderStrictConf()).not.toContain("Deny 10.0.0.0/8");
    }
  });

  it("treats other values as enabled", () => {
    process.env.LASTLIGHT_BLOCK_PRIVATE_IPS = "1";
    expect(renderStrictConf()).toContain("Deny 10.0.0.0/8");
  });
});
