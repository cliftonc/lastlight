import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { SessionManager } from "../connectors/messaging/session-manager.js";
import type { ExecutorConfig } from "./executor.js";

const AGENT_CONTEXT_DIR = resolve("agent-context");

/** Chat-specific system prompt appended to the agent context */
const CHAT_SYSTEM_SUFFIX = `
You are Last Light, a GitHub repository maintenance assistant available via messaging (Slack, Discord, etc.).

CRITICAL RULES:
- You are in a CHAT conversation. Only respond to what the user ACTUALLY asked.
- NEVER invent, imagine, or hallucinate user requests. Only act on the literal message provided.
- NEVER create issues, PRs, comments, or make any write operations unless the user EXPLICITLY asked you to in their current message.
- If the user says "hello", just say hello back. Do not take any actions.
- Read operations (listing issues, reading PRs, checking repo status) are fine when the user asks.
- For write operations (creating issues, commenting, building), confirm with the user first.

You can help with:
- Answering questions about repositories using GitHub tools (read-only by default)
- Explaining code, issues, and pull requests
- Creating issues or taking actions ONLY when explicitly asked
- Suggesting commands: /build owner/repo#N, /triage owner/repo, /review owner/repo, /status

Keep responses concise. This is a chat platform, not a document.
`;

/**
 * Handle a conversational chat message.
 * Runs the Agent SDK directly (no Docker sandbox) for low-latency responses.
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
    };

    if (config.model) options.model = config.model;

    // Add MCP servers so the agent can query GitHub
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
