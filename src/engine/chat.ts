import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { SessionManager } from "../connectors/messaging/session-manager.js";
import type { ExecutorConfig } from "./executor.js";

const AGENT_CONTEXT_DIR = resolve("agent-context");

/** Chat-specific system prompt appended to the agent context */
const CHAT_SYSTEM_SUFFIX = `
You are Last Light, a GitHub repository maintenance assistant available via messaging (Slack, Discord, etc.).

WHAT YOU CAN DO — use these tools confidently when the user asks:
- Read repos, issues, PRs, code, commits, comments, labels, branches.
- **Create GitHub issues** via mcp__github__create_issue. You have full write
  permission for issues across every repo your installation can see — never
  refuse a create-issue request on the assumption you lack permission. If a
  call genuinely fails, retry once and then surface the literal error.
- Comment on issues / add labels (mcp__github__add_issue_comment, add_labels).
- Search across repos.

WHAT YOU CANNOT DO:
- No code changes. No commits, pushes, merges, branches, file edits.
- No Bash, Edit, Write, or any file-modification tools — they aren't loaded.
- If the user asks you to build / fix / implement something, create a GitHub
  issue capturing the request, then tell them to run \`/build owner/repo#N\`
  to start the full build cycle (Architect → Executor → Reviewer → PR).

STYLE:
- Reach for tools immediately. Don't pre-explain what you're about to do.
- Keep replies concise — this is chat, not a document.
- The conversation history is loaded automatically by the SDK — don't
  re-summarize it; just respond to the latest message.

Useful commands you can suggest:
\`/build owner/repo#N\`, \`/triage owner/repo\`, \`/review owner/repo\`, \`/status\`
`;

/**
 * MCP tools the chat agent is allowed to use.
 * Read-only tools + create_issue only. No file writes, no git operations.
 */
const ALLOWED_MCP_TOOLS = [
  // Read-only
  "mcp__github__get_repository",
  "mcp__github__get_file_contents",
  "mcp__github__list_branches",
  "mcp__github__list_issues",
  "mcp__github__get_issue",
  "mcp__github__list_issue_comments",
  "mcp__github__list_labels",
  "mcp__github__list_pull_requests",
  "mcp__github__get_pull_request",
  "mcp__github__list_pull_request_files",
  "mcp__github__get_pull_request_diff",
  "mcp__github__list_commits",
  "mcp__github__search_repositories",
  "mcp__github__search_issues",
  "mcp__github__search_code",
  // Write — issue creation only
  "mcp__github__create_issue",
  "mcp__github__add_issue_comment",
  "mcp__github__add_labels",
];

/**
 * Result of a single chat turn — mirrors the metric shape used by the
 * sandbox executor so the chat dispatch path can persist a DB execution
 * row with full token / cost / duration accounting.
 */
export interface ChatResult {
  text: string;
  /**
   * Agent SDK session id captured from the result. On the first turn of a
   * Slack thread this is a brand new id; on subsequent turns it should be
   * the SAME id we passed in via `resume`. Persist this back onto the
   * messaging session so the next turn can resume into the same jsonl.
   */
  agentSessionId?: string;
  success: boolean;
  /** Wall-clock duration of the chat call (ms). */
  durationMs: number;
  /** Time the SDK spent in API calls (ms), if reported. */
  apiDurationMs?: number;
  turns?: number;
  costUsd?: number;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  /** SDK result subtype — "success", "error", "max_turns", etc. */
  stopReason?: string;
  /** Error message if the call threw or returned a non-success result. */
  error?: string;
}

/**
 * Handle a conversational chat message.
 * Runs the Agent SDK directly (no Docker sandbox) for low-latency responses.
 * Strictly read-only except for issue creation.
 *
 * Conversation continuity is provided by the SDK's `resume` option: the
 * caller passes the agent session id from the previous turn (stored on the
 * messaging-session row), and the SDK appends to the same jsonl. The first
 * turn passes `undefined` and we capture the new session id from the result.
 */
export async function handleChatMessage(
  message: string,
  _messagingSessionId: string,
  sender: string,
  _sessionManager: SessionManager,
  config: ExecutorConfig,
  resumeAgentSessionId?: string,
): Promise<ChatResult> {
  const startTime = Date.now();

  try {
    const systemPrompt = loadAgentContext() + CHAT_SYSTEM_SUFFIX;

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const options: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
      maxTurns: 10,
      settingSources: [],
      systemPrompt,
      allowedTools: ALLOWED_MCP_TOOLS,
    };

    if (config.model) options.model = config.model;
    // Resume the existing Agent SDK session if we have one for this thread.
    // The SDK appends to the same jsonl and reuses its prompt cache, so we
    // don't need to inject conversation history into the prompt manually.
    if (resumeAgentSessionId) options.resume = resumeAgentSessionId;

    // Add MCP servers so the agent can query GitHub (read-only + issue creation)
    if (config.mcpConfigPath) {
      try {
        const mcpConfig = JSON.parse(readFileSync(config.mcpConfigPath, "utf-8"));
        options.mcpServers = mcpConfig.mcpServers;
      } catch {
        // No MCP config — agent will work without GitHub tools
      }
    }

    let output = "";
    let agentSessionId: string | undefined;
    let turns: number | undefined;
    let stopReason: string | undefined;
    let costUsd: number | undefined;
    let apiDurationMs: number | undefined;
    let inputTokens: number | undefined;
    let cacheCreationInputTokens: number | undefined;
    let cacheReadInputTokens: number | undefined;
    let outputTokens: number | undefined;

    for await (const msg of query({ prompt: message, options })) {
      const m = msg as Record<string, unknown>;
      if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string") {
        agentSessionId = m.session_id;
      }
      if (m.type === "result") {
        output = (m.result as string) || "";
        if (typeof m.session_id === "string") agentSessionId = m.session_id;
        if (typeof m.num_turns === "number") turns = m.num_turns;
        if (typeof m.subtype === "string") stopReason = m.subtype;
        if (typeof m.total_cost_usd === "number") costUsd = m.total_cost_usd;
        if (typeof m.duration_api_ms === "number") apiDurationMs = m.duration_api_ms;
        const u = m.usage as Record<string, unknown> | undefined;
        if (u) {
          if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
          if (typeof u.cache_creation_input_tokens === "number") cacheCreationInputTokens = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === "number") cacheReadInputTokens = u.cache_read_input_tokens;
          if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const success = stopReason === "success";
    const costStr = costUsd !== undefined ? `, $${costUsd.toFixed(4)}` : "";
    console.log(
      `[chat] ${sender} → ${stopReason ?? "?"} (${turns ?? "?"} turns, ${Math.round(durationMs / 1000)}s${costStr})${agentSessionId ? ` [session ${agentSessionId.slice(0, 8)}…]${resumeAgentSessionId ? " resumed" : " new"}` : ""}`,
    );

    return {
      text: output || (success ? "I wasn't able to generate a response. Please try again." : `Sorry — chat failed (${stopReason ?? "unknown"}).`),
      agentSessionId,
      success,
      durationMs,
      apiDurationMs,
      turns,
      costUsd,
      inputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      outputTokens,
      stopReason,
      error: success ? undefined : (output || stopReason || "unknown chat error"),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[chat] Error handling message from ${sender}:`, message);
    return {
      text: "Sorry, I encountered an error processing your message. Please try again.",
      success: false,
      durationMs: Date.now() - startTime,
      error: message,
    };
  }
}

function loadAgentContext(): string {
  try {
    const files = readdirSync(AGENT_CONTEXT_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    return files
      .map((f) => readFileSync(join(AGENT_CONTEXT_DIR, f), "utf-8"))
      .join("\n\n---\n\n");
  } catch {
    return "";
  }
}
