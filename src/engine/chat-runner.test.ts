import { describe, it, expect, vi } from "vitest";
import type { AssistantMessage, Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeWithRetry, isRetryableModelError } from "./chat-runner.js";

// Minimal stand-ins — the helper only ever forwards these to `complete`.
const model = {} as Model<Api>;
const context = { messages: [] } as unknown as Context;
const opts = {} as SimpleStreamOptions;

function ok(text = "hi"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as unknown as AssistantMessage;
}

function erroredAssistant(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as unknown as AssistantMessage;
}

const noSleep = () => Promise.resolve();
const delays = [10, 20, 30];

describe("isRetryableModelError", () => {
  it("matches rate limits and transient server/network errors", () => {
    for (const m of [
      '429 {"error":{"code":"RATE_LIMIT_EXCEEDED"}}',
      "You have exceeded your rate limit for this API",
      "Error: overloaded_error",
      "503 Service Unavailable",
      "502 Bad Gateway",
      "fetch failed",
      "ETIMEDOUT",
    ]) {
      expect(isRetryableModelError(m)).toBe(true);
    }
  });

  it("does NOT match auth / validation / overflow (non-transient)", () => {
    for (const m of [
      "401 Unauthorized",
      "403 Resource not accessible by integration",
      "400 invalid_request_error",
      "context length exceeded",
      "Unknown chat model",
    ]) {
      expect(isRetryableModelError(m)).toBe(false);
    }
  });
});

describe("completeWithRetry", () => {
  it("returns immediately on success (no retries)", async () => {
    const complete = vi.fn().mockResolvedValue(ok());
    const onRetry = vi.fn();
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn: noSleep, onRetry });
    expect(res.stopReason).toBe("stop");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a thrown 429 then succeeds, backing off per the schedule", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 {"code":"RATE_LIMIT_EXCEEDED"}'))
      .mockResolvedValueOnce(ok("recovered"));
    const slept: number[] = [];
    const sleepFn = (ms: number) => { slept.push(ms); return Promise.resolve(); };
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn });
    expect(res.stopReason).toBe("stop");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([10]); // first backoff only
  });

  it("retries an errored-assistant 429 (non-throw shape)", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(erroredAssistant("rate limit exceeded"))
      .mockResolvedValueOnce(ok());
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn: noSleep });
    expect(res.stopReason).toBe("stop");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-retryable thrown error", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    await expect(
      completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn: noSleep }),
    ).rejects.toThrow("401");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting the backoff schedule and rethrows the last error", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("429 rate limit"));
    const slept: number[] = [];
    await expect(
      completeWithRetry(complete, model, context, opts, {
        delaysMs: delays,
        sleepFn: (ms) => { slept.push(ms); return Promise.resolve(); },
      }),
    ).rejects.toThrow("429");
    expect(complete).toHaveBeenCalledTimes(delays.length + 1); // initial + 3 retries
    expect(slept).toEqual(delays);
  });

  it("returns the errored assistant unchanged when retries are exhausted (non-throw shape)", async () => {
    const complete = vi.fn().mockResolvedValue(erroredAssistant("429 rate limit"));
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: [5], sleepFn: noSleep });
    expect(res.stopReason).toBe("error");
    expect(complete).toHaveBeenCalledTimes(2); // initial + 1 retry, then surfaces the errored assistant
  });
});
