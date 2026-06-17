import { describe, it, expect } from "vitest";
import { RunResultAccumulator } from "./agent-executor.js";

/**
 * A pi assistant `message_end` event carrying per-message usage. Mirrors the
 * shape lastlight receives over the JSONL stream (pi `Usage`: input / output /
 * cacheRead / cacheWrite + a nested `cost`).
 */
function assistantMessageEnd(opts: {
  text?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost: number;
  toolCalls?: number;
}): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (let i = 0; i < (opts.toolCalls ?? 0); i++) {
    content.push({ type: "toolCall", id: `t${i}`, name: "read", arguments: {} });
  }
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content,
      usage: {
        input: opts.input,
        output: opts.output,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        cost: { total: opts.cost },
      },
    },
  };
}

/** The terminal `usage_snapshot` pi synthesizes from getSessionStats(). */
function usageSnapshot(stats: {
  assistantMessages: number;
  input: number;
  output: number;
  cost: number;
}): Record<string, unknown> {
  return {
    type: "usage_snapshot",
    stats: {
      userMessages: 0,
      assistantMessages: stats.assistantMessages,
      toolCalls: 0,
      toolResults: 0,
      tokens: {
        input: stats.input,
        output: stats.output,
        cacheRead: 0,
        cacheWrite: 0,
        total: stats.input + stats.output,
      },
      cost: stats.cost,
    },
  };
}

describe("RunResultAccumulator usage accounting", () => {
  it("sums per-message usage across assistant message_end events", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 100, output: 20, cost: 0.01, toolCalls: 1 }));
    acc.feed(assistantMessageEnd({ input: 200, output: 30, cacheRead: 50, cost: 0.02 }));
    acc.feed({ type: "agent_end", messages: [] });

    const stats = acc.bestStats();
    expect(stats).toBeDefined();
    expect(stats?.assistantMessages).toBe(2);
    expect(stats?.tokens.input).toBe(300);
    expect(stats?.tokens.output).toBe(50);
    expect(stats?.tokens.cacheRead).toBe(50);
    expect(stats?.tokens.total).toBe(400);
    expect(stats?.cost).toBeCloseTo(0.03, 6);
    expect(stats?.toolCalls).toBe(1);
  });

  it("prefers per-message accumulation when a compaction zeroes the snapshot", () => {
    // Simulates auto-compaction: real per-message usage streamed, but the
    // terminal snapshot recomputed from the wiped message window reports zero
    // (num_turns 0, cost 0) — the exact bug seen on the build phases.
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 5000, output: 800, cacheRead: 12000, cost: 0.42 }));
    acc.feed(assistantMessageEnd({ input: 3000, output: 400, cost: 0.18 }));
    acc.feed(usageSnapshot({ assistantMessages: 0, input: 0, output: 0, cost: 0 }));
    acc.feed({ type: "agent_end", messages: [] });

    const stats = acc.bestStats();
    expect(stats?.assistantMessages).toBe(2);
    expect(stats?.tokens.input).toBe(8000);
    expect(stats?.tokens.output).toBe(1200);
    expect(stats?.tokens.cacheRead).toBe(12000);
    expect(stats?.cost).toBeCloseTo(0.6, 6);

    // build() carries the same compaction-proof stats through to ExecutionResult.
    expect(acc.build(0).stats?.cost).toBeCloseTo(0.6, 6);
  });

  it("falls back to the snapshot when no per-message usage was reported", () => {
    // A provider that doesn't populate per-message usage: assistant messages
    // exist but their usage is all-zero, so the (non-compacted) snapshot wins.
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 0, output: 0, cost: 0 }));
    acc.feed(usageSnapshot({ assistantMessages: 1, input: 1234, output: 567, cost: 0.05 }));

    const stats = acc.bestStats();
    expect(stats?.tokens.input).toBe(1234);
    expect(stats?.tokens.output).toBe(567);
    expect(stats?.cost).toBeCloseTo(0.05, 6);
  });

  it("returns undefined stats when nothing was observed", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    expect(acc.bestStats()).toBeUndefined();
  });
});

describe("RunResultAccumulator extension status", () => {
  it("captures and normalizes extension_status events", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed({
      type: "extension_status",
      extension: "file-search",
      status: "configured",
      mode: "override",
      toolCount: 3,
    });
    acc.feed({
      type: "extension_status",
      extension: "github",
      status: "configured",
      profile: "repo-write",
      toolCount: 5,
    });
    acc.feed({
      type: "extension_status",
      extension: "web-search",
      status: "skipped",
      reason: "no-credentials",
    });

    const ext = acc.extensions();
    expect(ext).toEqual({
      "file-search": { status: "configured", mode: "override", toolCount: 3 },
      github: { status: "configured", toolCount: 5 },
      "web-search": { status: "skipped", reason: "no-credentials" },
    });
  });

  it("returns undefined when no extension_status events were seen", () => {
    const acc = new RunResultAccumulator();
    acc.feed({ type: "session", id: "abc" });
    acc.feed(assistantMessageEnd({ input: 10, output: 5, cost: 0.001 }));
    expect(acc.extensions()).toBeUndefined();
  });
});
