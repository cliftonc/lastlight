import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn().mockReturnValue("fake-pem") };
});

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    createSign: vi.fn().mockReturnValue({
      update: vi.fn(),
      sign: vi.fn().mockReturnValue("fakesig"),
    }),
  };
});

import { execSync, execFileSync } from "child_process";
import { configureGitAuth, refreshGitAuth } from "./git-auth.js";

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

function mockFetchToken(token = "ghs_testtoken123") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token, expires_at: "2099-01-01T00:00:00Z" }),
    })
  );
}

const baseConfig = {
  appId: "12345",
  privateKeyPath: "/fake/key.pem",
  installationId: "67890",
};

describe("git-auth — no shell injection via execFileSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchToken();
    delete process.env.LASTLIGHT_LOCAL_DEV;
  });

  it("configureGitAuth does not use execSync", async () => {
    await configureGitAuth(baseConfig);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("configureGitAuth calls execFileSync with git array args", async () => {
    await configureGitAuth(baseConfig);
    expect(mockExecFileSync).toHaveBeenCalled();
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }
  });

  it("configureGitAuth passes credential.helper token as a separate array element", async () => {
    const token = "ghs_testtoken123";
    mockFetchToken(token);
    await configureGitAuth(baseConfig);
    const credHelperCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("credential.helper")
    );
    expect(credHelperCall).toBeDefined();
    const args = credHelperCall![1] as string[];
    const valueArg = args[args.length - 1];
    // Value arg must not be shell-quoted
    expect(valueArg).not.toMatch(/^'/);
    expect(valueArg).not.toMatch(/'$/);
  });

  it("refreshGitAuth does not use execSync", async () => {
    await refreshGitAuth(baseConfig);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("refreshGitAuth calls execFileSync with git array args", async () => {
    await refreshGitAuth(baseConfig);
    expect(mockExecFileSync).toHaveBeenCalled();
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }
  });
});
