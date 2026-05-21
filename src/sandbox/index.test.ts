import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "child_process";
import { __prePopulateWorkspaceForTest as prePopulateWorkspace } from "./index.js";

const mockExec = vi.mocked(execFileSync);

const TOKEN = "ghs_secret123ABC_xyz";

describe("prePopulateWorkspace token-leak protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockExec.mockReset();
  });

  it("does not leak the token into the success log line", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });
    const joined = logSpy.mock.calls.flat().join("\n");
    expect(joined).not.toContain(TOKEN);
  });

  it("redacts the token from the warning when git clone fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // execFileSync surfaces command failures with an Error whose .message
    // echoes the full command — including the authenticated URL. Reproduce
    // that shape here.
    const failure = new Error(
      `Command failed: git clone --branch opencode-fork --depth 50 ` +
      `https://x-access-token:${TOKEN}@github.com/cliftonc/lastlight.git /tmp/work\n` +
      `fatal: could not create work tree dir '/tmp/work'`,
    );
    mockExec.mockImplementation(() => { throw failure; });

    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0].join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("[REDACTED-TOKEN]");
    // Sanity: the non-secret part of the diagnostic is preserved.
    expect(logged).toContain("opencode-fork");
    expect(logged).toContain("Pre-clone");
  });

  it("refuses to embed tokens containing characters outside [A-Za-z0-9_-]", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => prePopulateWorkspace("/tmp/work", {
      owner: "x",
      repo: "y",
      branch: "z",
      token: 'evil";rm -rf /;"',
    })).toThrow(/outside \[A-Za-z0-9_-\]/);
    expect(mockExec).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
