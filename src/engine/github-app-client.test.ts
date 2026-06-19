import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const octokitInstance = { sentinel: "octokit" };
const createAppAuth = vi.fn();
const Octokit = vi.fn(function () {
  return octokitInstance;
});

vi.mock("octokit", () => ({
  Octokit,
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth,
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("githubAppClient", () => {
  it("constructs an Octokit GitHub App client from a private key file", async () => {
    const fixturePrivateKey = "-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----\n";
    const tempDir = mkdtempSync(join(tmpdir(), "github-app-client-"));
    tempDirs.push(tempDir);
    const privateKeyPath = join(tempDir, "app.pem");
    writeFileSync(privateKeyPath, fixturePrivateKey);

    const { githubAppClient } = await import("./github-app-client.js");

    const client = githubAppClient({ appId: "123", installationId: "456", privateKeyPath });

    expect(client).toBe(octokitInstance);
    expect(Octokit).toHaveBeenCalledOnce();
    expect(Octokit).toHaveBeenCalledWith({
      authStrategy: createAppAuth,
      auth: {
        appId: "123",
        privateKey: fixturePrivateKey,
        installationId: "456",
      },
    });
  });
});
