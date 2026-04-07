import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { Connector, EventEnvelope } from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { MessagingConfig, IncomingMessageParams } from "./types.js";

/**
 * Abstract base class for messaging platform connectors.
 *
 * Handles common logic: allowlist checks, DM vs channel behavior,
 * session management, and EventEnvelope construction.
 *
 * Subclasses implement platform-specific transport (Slack Socket Mode,
 * Discord Gateway, Teams Bot Framework, etc.) and the three abstract methods.
 */
export abstract class MessagingConnector extends EventEmitter implements Connector {
  abstract readonly name: string;
  protected config: MessagingConfig;
  protected sessionManager: SessionManager;

  constructor(config: MessagingConfig, sessionManager: SessionManager) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /** Send a text message to a channel/thread */
  abstract sendMessage(channelId: string, threadId: string | null, text: string): Promise<string | void>;
  /** Add an emoji reaction to a message */
  abstract addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Show a typing/processing indicator */
  abstract showTyping(channelId: string, messageId: string): Promise<void>;
  /** Clear the typing/processing indicator (optional — not all platforms need this) */
  async clearTyping(_channelId: string, _threadId: string): Promise<void> {}

  /**
   * Process an incoming message from any platform.
   * Called by platform-specific event listeners.
   */
  protected async handleIncomingMessage(params: IncomingMessageParams): Promise<void> {
    const { platformUserId, platformUsername, channelId, threadId, messageId, text, isDM, isMention, raw } = params;

    // Allowlist check
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(platformUserId)) {
      console.log(`[${this.name}] Ignoring message from unauthorized user: ${platformUsername} (${platformUserId})`);
      return;
    }

    // In channels, only respond to @mentions
    if (!isDM && !isMention) {
      return;
    }

    // Strip bot mention from the message text
    const cleanText = this.stripBotMention(text).trim();
    if (!cleanText) return;

    // Show acknowledgment
    this.showTyping(channelId, messageId).catch(() => {});

    // Get or create session
    const session = this.sessionManager.getOrCreateSession({
      platform: this.name,
      channelId,
      threadId: threadId || messageId, // Use message ID as thread root if no thread
      userId: platformUserId,
    });

    // Record the user message
    this.sessionManager.addMessage(session.id, "user", cleanText, messageId);
    this.sessionManager.touchSession(session.id);

    // Build the reply callback — sends to same channel/thread
    const replyThreadId = threadId || messageId;
    const reply = async (msg: string) => {
      // Clear thinking indicator before sending response
      this.clearTyping(channelId, replyThreadId).catch(() => {});
      // Chunk long messages
      const chunks = this.chunkMessage(msg);
      for (const chunk of chunks) {
        await this.sendMessage(channelId, replyThreadId, chunk);
      }
      // Record assistant message
      this.sessionManager.addMessage(session.id, "assistant", msg);
    };

    // Build EventEnvelope
    const envelope: EventEnvelope = {
      id: `${this.name}-${messageId}`,
      source: this.name,
      type: "message",
      sender: platformUsername,
      senderIsBot: false,
      body: cleanText,
      raw: {
        ...typeof raw === "object" && raw !== null ? raw : {},
        sessionId: session.id,
        platformUserId,
        channelId,
        threadId: replyThreadId,
      },
      reply,
      timestamp: new Date(),
    };

    this.emit("event", envelope);
  }

  /** Strip the bot @mention from message text */
  protected stripBotMention(text: string): string {
    if (!this.config.botIdentifier) return text;
    // Generic pattern — subclasses can override for platform-specific mention formats
    const mentionPattern = new RegExp(`<@${this.config.botIdentifier}>|@${this.config.botIdentifier}`, "gi");
    return text.replace(mentionPattern, "").trim();
  }

  /** Split a message into chunks that fit platform limits */
  protected chunkMessage(text: string, maxLength = 3000): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to break at a newline
      let breakPoint = remaining.lastIndexOf("\n", maxLength);
      if (breakPoint < maxLength * 0.5) {
        // No good newline break — try space
        breakPoint = remaining.lastIndexOf(" ", maxLength);
      }
      if (breakPoint < maxLength * 0.3) {
        // No good break — hard cut
        breakPoint = maxLength;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return chunks;
  }
}
