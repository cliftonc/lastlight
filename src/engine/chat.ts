import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { SessionManager } from "../connectors/messaging/session-manager.js";
import type { ExecutorConfig } from "./executor.js";

const AGENT_CONTEXT_DIR = resolve("agent-context");

/** Chat-specific system prompt appended to the agent context */
const CHAT_SYSTEM_SUFFIX = `
You are Last Light, a GitHub repository maintenance assistant available via messaging.
You are having a conversation with a user. Be concise and helpful.

You can help with:
- Answering questions about repositories
- Explaining code, issues, and pull requests
- Triggering actions like triaging issues or reviewing PRs (tell the user to use commands like /build, /triage, /review)
- Providing status updates on running tasks

Keep responses focused and actionable. Use markdown formatting sparingly — messaging platforms have limited rendering.
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
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    // Build prompt with history
    const prompt = historyText
      ? `Previous conversation:\n${historyText}\n\nUser: ${message}`
      : message;

    // Load agent context (soul, rules, etc.)
    const systemPrompt = loadAgentContext() + CHAT_SYSTEM_SUFFIX;

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const options: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
      maxTurns: 10, // Chat should be quick — limit turns
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
