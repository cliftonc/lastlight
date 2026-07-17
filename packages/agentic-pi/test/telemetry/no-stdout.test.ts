/**
 * The dominant risk of the OTEL integration is breaking the `run()` no-stdout
 * contract: the SDK and OTLP exporter `diag.error()` on failure, and a careless
 * setup would let that reach the console.
 *
 * This guard runs the REAL telemetry pipeline (dynamic SDK import, live
 * BatchSpanProcessor + OTLP/HTTP exporter) pointed at a dead endpoint, drives a
 * full event cycle, and shuts down — all in a child process so the test
 * runner's own reporter output isn't counted. It asserts the child wrote
 * nothing to stdout/stderr even though every export fails. No API key needed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TELEMETRY_SRC = join(__dirname, "..", "..", "src", "telemetry", "index.ts");

describe("telemetry no-stdout contract", () => {
  test("enabled OTEL with an unreachable collector writes nothing to stdout/stderr", () => {
    const inline = `
import { createTelemetry } from ${JSON.stringify(TELEMETRY_SRC)};

const handle = await createTelemetry({
  config: { enabled: true, includeContent: false, endpoint: "http://127.0.0.1:1" },
  sessionId: "sess-test",
  model: "openai/gpt-5.4-nano",
  sandboxBackend: "none",
  onWarn: () => {},
});

handle.onEvent({ type: "agent_start" });
handle.onEvent({ type: "turn_start" });
handle.onEvent({ type: "message_start", message: { role: "assistant", model: "gpt-5.4-nano", provider: "openai" } });
handle.onEvent({ type: "message_end", message: { role: "assistant", model: "gpt-5.4-nano", provider: "openai", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } }, content: [{ type: "text", text: "hi" }] } });
handle.onEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
handle.onEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, isError: false });
handle.onEvent({ type: "turn_end" });
handle.onEvent({ type: "agent_end", messages: [] });
await handle.shutdown();
`;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", inline],
      {
        encoding: "utf8",
        // Cap the per-attempt OTLP timeout so the dead-endpoint flush returns
        // fast instead of exhausting the exporter's default retry/backoff.
        env: { ...process.env, OTEL_EXPORTER_OTLP_TIMEOUT: "300", OTEL_BSP_SCHEDULE_DELAY: "50" },
        timeout: 30_000,
      },
    );

    assert.equal(
      child.status,
      0,
      `child exited non-zero (${child.status}). stderr: ${child.stderr}`,
    );
    assert.equal(
      child.stdout,
      "",
      `telemetry wrote to stdout: ${JSON.stringify(child.stdout.slice(0, 500))}`,
    );
    assert.equal(
      child.stderr,
      "",
      `telemetry wrote to stderr: ${JSON.stringify(child.stderr.slice(0, 500))}`,
    );
  });
});
