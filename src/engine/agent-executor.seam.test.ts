/**
 * Core's half of the GitHub-mock seam contract.
 *
 * The eval harness (now in the separate `lastlight-evals` package) mocks GitHub
 * by pointing `ExecutorConfig.githubApiBaseUrl` at an in-process fake and
 * trusting that core forwards that base URL into agentic-pi's built-in
 * `github_*` tools. The full red→green integration round-trip lives in
 * lastlight-evals; THIS test is core's lightweight guard that the one line of
 * plumbing still exists — if core ever stops forwarding `githubApiBaseUrl`,
 * core's own `npm test` must go red rather than silently breaking every
 * downstream eval.
 *
 * No fake server, no AI, no provider keys: we mock `agentic-pi` so its `run`
 * captures its options and throws immediately (the executor's catch path then
 * returns a failure result), and assert the captured options carried our URL.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const runSpy = vi.fn();

// Intercept BOTH the static and the executor's dynamic `import("agentic-pi")`.
vi.mock("agentic-pi", () => ({
  run: (opts: unknown) => {
    runSpy(opts);
    // Bail out the moment we've captured the args — we only care about the
    // forwarded base URL, not about actually running an agent.
    throw new Error("seam-test: stop after capturing run options");
  },
}));

// Imported AFTER vi.mock so the dynamic import inside resolves to the mock.
const { executeAgent } = await import("./agent-executor.js");

describe("agentic-pi githubApiBaseUrl seam (core side)", () => {
  beforeEach(() => runSpy.mockClear());

  it("forwards ExecutorConfig.githubApiBaseUrl into the agentic-pi run", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-seam-"));
    const sessionsDir = join(stateDir, "agent-sessions");
    // The shim appends per-phase jsonl under <sessionsDir>/projects/<slug>/ and
    // does not create that parent recursively.
    mkdirSync(join(sessionsDir, "projects"), { recursive: true });

    const fakeUrl = "http://127.0.0.1:65535";
    // sandbox:"none" + no githubAccess → prepareRun mints no token, runs
    // in-process, and reaches the agenticRun call with no network or keys.
    const result = await executeAgent("noop prompt", {
      sandbox: "none",
      stateDir,
      sessionsDir,
      githubApiBaseUrl: fakeUrl,
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0]).toMatchObject({ githubApiBaseUrl: fakeUrl });
    // The mock threw, so the executor returns a failure result — that's fine;
    // the contract under test is purely the forwarded URL.
    expect(result.success).toBe(false);
  });
});
