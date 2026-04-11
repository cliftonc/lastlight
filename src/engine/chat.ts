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
- Treat conversation history as background context, not a queue of actions.

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
 * Handle a conversational chat message.
 * Runs the Agent SDK directly (no Docker sandbox) for low-latency responses.
 * Strictly read-only except for issue creation.
 */
export async function handleChatMessage(
  message: string,
  sessionId: string,
  sender: string,
  sessionManager: SessionManager,
  config: ExecutorConfig
): Promise<string> {
  const startTime = Date.now();

  try {
    // Load conversation history for context
    const history = sessionManager.getHistory(sessionId, 20);
    const historyText = history
      .map((m) => `[${m.role}]: ${m.content}`)
      .join("\n\n");

    // Build prompt with history — clearly delineate history from current message
    const prompt = historyText
      ? `<conversation_history>\n${historyText}\n</conversation_history>\n\nRespond to this message: ${message}`
      : message;

    // Load agent context (soul, rules, etc.)
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

    for await (const msg of query({ prompt, options })) {
      const m = msg as any;
      if (m.type === "result") {
        output = m.result || "";
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[chat] Response for ${sender} in ${durationMs}ms`);

    return output || "I wasn't able to generate a response. Please try again.";
  } catch (err: any) {
    console.error(`[chat] Error handling message from ${sender}:`, err.message);
    return "Sorry, I encountered an error processing your message. Please try again.";
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
