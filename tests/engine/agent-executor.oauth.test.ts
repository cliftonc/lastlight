/**
 * Executor OAuth env injection — the sandbox path can only carry OAuth creds
 * via env, so `prepareRun` injects the provider's OAuth env var when the run's
 * model is OAuth-backed and a login exists:
 *   - anthropic  → ANTHROPIC_OAUTH_TOKEN
 *   - copilot    → COPILOT_GITHUB_TOKEN
 *   - codex      → no env route → nothing injected (chat-only)
 *
 * We capture the env handed to the sandbox via FakeSandbox and stub
 * `resolveOAuthApiKey` so the assertion is about the wiring, not pi-ai's token
 * internals or the network.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveOAuthApiKeySpy = vi.fn();
vi.mock("#src/engine/oauth.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/oauth.js")>();
  return { ...actual, resolveOAuthApiKey: (...a: unknown[]) => resolveOAuthApiKeySpy(...a) };
});

const { executeAgent } = await import("#src/engine/agent-executor.js");
const { FakeSandbox } = await import("#src/sandbox/sandbox.js");

function stateDirs() {
  const stateDir = mkdtempSync(join(tmpdir(), "ll-exec-oauth-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  return { stateDir, sessionsDir };
}

async function runWithModel(model: string) {
  const { stateDir, sessionsDir } = stateDirs();
  const fake = new FakeSandbox({ returnRunResult: { success: true } as any });
  await executeAgent("noop", { sandbox: "none", stateDir, sessionsDir, model }, {
    sandboxFactory: fake.asFactory(),
  });
  return fake;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  resolveOAuthApiKeySpy.mockReset();
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.COPILOT_GITHUB_TOKEN;
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("executor OAuth env injection", () => {
  it("injects ANTHROPIC_OAUTH_TOKEN for an Anthropic OAuth model with a login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "ant-oauth-tok", credentials: {} });
    const fake = await runWithModel("anthropic/claude-sonnet-4-6");
    expect(resolveOAuthApiKeySpy).toHaveBeenCalledWith("anthropic", undefined, expect.any(String));
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBe("ant-oauth-tok");
  });

  it("injects COPILOT_GITHUB_TOKEN for a Copilot OAuth model with a login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "copilot-tok", credentials: {} });
    const fake = await runWithModel("github-copilot/gpt-4o");
    expect(fake.env?.COPILOT_GITHUB_TOKEN).toBe("copilot-tok");
  });

  it("injects NOTHING for a Codex model (no sandbox env route) and never resolves a token", async () => {
    const fake = await runWithModel("openai-codex/gpt-5.4");
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(fake.env?.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  it("injects nothing for an Anthropic model with no stored login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue(null);
    const fake = await runWithModel("anthropic/claude-sonnet-4-6");
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
  });

  it("skips store resolution when an explicit ANTHROPIC_OAUTH_TOKEN is already in the env", async () => {
    // A hand-set token is respected as an override: we don't spend a refresh
    // resolving from the store on top of it.
    process.env.ANTHROPIC_OAUTH_TOKEN = "preset-token";
    await runWithModel("anthropic/claude-sonnet-4-6");
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
  });

  it("does not resolve OAuth for a plain API-key model", async () => {
    const fake = await runWithModel("openai/gpt-5.5");
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
    expect(fake.env?.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
  });
});
