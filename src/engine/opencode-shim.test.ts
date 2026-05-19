import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeJsonlShim, projectSlugForCwd } from "./opencode-shim.js";

/**
 * Fixture: an AgentEvent[] captured from a synthetic OpenCode run that
 * exercises every translation branch — a `text` event, an MCP `tool_use`
 * call (github_create_issue), a non-MCP `tool_use` call (read), a
 * non-completed `tool_use` (state.status omitted), and an `error`.
 */
const SESSION_ID = "ses_1bf8753b5ffeuMqRaPyPqjz89i";
const FIXTURE_EVENTS: object[] = [
  { type: "step_start", timestamp: 1779198112358, sessionID: SESSION_ID, part: { type: "step-start" } },
  {
    type: "text",
    timestamp: 1779198112500,
    sessionID: SESSION_ID,
    part: { type: "text", text: "Hello from OpenCode" },
  },
  {
    type: "tool_use",
    timestamp: 1779198112700,
    sessionID: SESSION_ID,
    part: {
      type: "tool",
      tool: "github_create_issue",
      callID: "call_mcp_001",
      state: {
        status: "completed",
        input: { owner: "cliftonc", repo: "lastlight", title: "demo" },
        output: "<issue url='https://github.com/cliftonc/lastlight/issues/42' />",
      },
    },
  },
  {
    type: "tool_use",
    timestamp: 1779198112800,
    sessionID: SESSION_ID,
    part: {
      type: "tool",
      tool: "read",
      callID: "call_read_001",
      state: {
        status: "completed",
        input: { filePath: "/abs/file" },
        output: "file contents",
      },
    },
  },
  {
    type: "tool_use",
    timestamp: 1779198112900,
    sessionID: SESSION_ID,
    part: {
      type: "tool",
      tool: "write",
      callID: "call_write_001",
      state: {
        status: "error",
        input: { filePath: "/abs/file", content: "x" },
        output: "permission denied",
      },
    },
  },
  {
    type: "error",
    timestamp: 1779198113000,
    sessionID: SESSION_ID,
    error: { data: { message: "rate limit hit" }, name: "RateLimitError" },
  },
  {
    type: "step_finish",
    timestamp: 1779198113100,
    sessionID: SESSION_ID,
    part: { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 100, output: 10, cache: { read: 0, write: 0 } } },
  },
];

describe("projectSlugForCwd", () => {
  it("converts the sandbox workspace path", () => {
    expect(projectSlugForCwd("/home/agent/workspace")).toBe("-home-agent-workspace");
  });
  it("converts the harness chat path", () => {
    expect(projectSlugForCwd("/app")).toBe("-app");
  });
});

describe("ClaudeJsonlShim", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencode-shim-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function feedAll(shim: ClaudeJsonlShim, events: object[]): Promise<void> {
    for (const evt of events) shim.feed(evt);
    await shim.flush();
  }

  function readJsonl(slug: string, id: string): Array<Record<string, unknown>> {
    const file = join(dir, "projects", slug, `${id}.jsonl`);
    const raw = readFileSync(file, "utf-8").trim().split("\n");
    return raw.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("writes file under claudeHomeDir/projects/<slug>/<sessionId>.jsonl", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      model: "openai/gpt-5.3-codex",
      initialPrompt: "do the thing",
    });
    await feedAll(shim, FIXTURE_EVENTS);

    const file = join(dir, "projects", "-home-agent-workspace", `${SESSION_ID}.jsonl`);
    expect(existsSync(file)).toBe(true);
  });

  it("emits the initial user prompt as the first envelope", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "run a triage",
    });
    await feedAll(shim, FIXTURE_EVENTS);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    expect(lines[0]).toMatchObject({
      type: "user",
      message: { role: "user", content: "run a triage" },
    });
  });

  it("translates `text` events to assistant text envelopes", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      model: "openai/gpt-5.3-codex",
      initialPrompt: "p",
    });
    await feedAll(shim, FIXTURE_EVENTS);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    const textLine = lines.find(
      (l) =>
        l.type === "assistant" &&
        Array.isArray((l.message as { content?: unknown })?.content) &&
        ((l.message as { content: Array<{ type: string }> }).content[0]?.type === "text"),
    );
    expect(textLine).toBeDefined();
    const msg = textLine!.message as { model?: string; content: Array<{ type: string; text: string }> };
    expect(msg.model).toBe("openai/gpt-5.3-codex");
    expect(msg.content[0].text).toBe("Hello from OpenCode");
  });

  it("prepends mcp_ to MCP server tool names but leaves built-ins alone", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    await feedAll(shim, FIXTURE_EVENTS);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    const toolUses = lines.flatMap((l) => {
      if (l.type !== "assistant") return [];
      const content = (l.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return [];
      return content.filter(
        (b: unknown): b is { type: string; name: string } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "tool_use",
      );
    });
    const names = toolUses.map((b) => b.name);
    expect(names).toContain("mcp_github_create_issue");
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).not.toContain("github_create_issue"); // must have been translated
  });

  it("emits tool_result envelopes for completed AND error tool calls", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    await feedAll(shim, FIXTURE_EVENTS);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    const results = lines.flatMap((l) => {
      if (l.type !== "user") return [];
      const content = (l.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) return [];
      return content.filter(
        (b: unknown): b is { type: string; tool_use_id: string; is_error?: boolean; content: unknown } =>
          !!b && typeof b === "object" && (b as { type?: string }).type === "tool_result",
      );
    });
    const ids = results.map((r) => r.tool_use_id);
    expect(ids).toEqual(expect.arrayContaining(["call_mcp_001", "call_read_001", "call_write_001"]));
    const errResult = results.find((r) => r.tool_use_id === "call_write_001");
    expect(errResult?.is_error).toBe(true);
  });

  it("translates error events to assistant isApiErrorMessage envelopes", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    await feedAll(shim, FIXTURE_EVENTS);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    const err = lines.find((l) => l.isApiErrorMessage === true);
    expect(err).toBeDefined();
    expect(err!.error).toBe("rate limit hit");
  });

  it("step_start / step_finish / reasoning are no-ops", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    await feedAll(shim, [
      { type: "step_start", sessionID: SESSION_ID, timestamp: 1, part: {} },
      { type: "step_finish", sessionID: SESSION_ID, timestamp: 2, part: { reason: "stop" } },
      { type: "reasoning", sessionID: SESSION_ID, timestamp: 3, part: { text: "thinking" } },
    ]);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    // Only the initial user prompt should appear.
    expect(lines.length).toBe(1);
    expect(lines[0].type).toBe("user");
  });

  it("finalize() appends a `result` envelope", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    shim.feed(FIXTURE_EVENTS[0]); // step_start carries sessionID
    shim.finalize({
      finalText: "all done",
      turns: 3,
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 0,
      stopReason: "success",
      durationMs: 1234,
    });
    await shim.flush();
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    const result = lines.find((l) => l.type === "result");
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("success");
    expect(result!.num_turns).toBe(3);
    expect(result!.total_input_tokens).toBe(100);
    expect(result!.total_cache_read_input_tokens).toBe(50);
    expect(result!.duration_ms).toBe(1234);
  });

  it("ignores events with no sessionID", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    shim.feed({ type: "text", part: { text: "no session" } });
    await shim.flush();
    expect(shim.isInitialized).toBe(false);
  });

  it("emits envelopes in feed order", async () => {
    const shim = new ClaudeJsonlShim({
      claudeHomeDir: dir,
      projectSlug: "-home-agent-workspace",
      mcpServerNames: ["github"],
      initialPrompt: "p",
    });
    await feedAll(shim, FIXTURE_EVENTS);
    const lines = readJsonl("-home-agent-workspace", SESSION_ID);
    // Expected order:
    //   user(prompt) → assistant(text) → assistant(tool_use mcp) → user(tool_result)
    //   → assistant(tool_use read) → user(tool_result) → assistant(tool_use write)
    //   → user(tool_result is_error) → assistant(isApiErrorMessage)
    const kinds = lines.map((l) => {
      if (l.isApiErrorMessage) return "api_error";
      if (l.type === "user") {
        const c = (l.message as { content?: unknown }).content;
        if (Array.isArray(c) && (c[0] as { type?: string }).type === "tool_result") return "tool_result";
        return "user";
      }
      if (l.type === "assistant") {
        const c = (l.message as { content?: unknown }).content;
        if (Array.isArray(c) && (c[0] as { type?: string }).type === "tool_use") return "tool_use";
        return "text";
      }
      return l.type;
    });
    expect(kinds).toEqual([
      "user",
      "text",
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
      "tool_use",
      "tool_result",
      "api_error",
    ]);
  });
});
