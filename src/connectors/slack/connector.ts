import { App } from "@slack/bolt";
import { MessagingConnector } from "../messaging/base.js";
import type { SessionManager } from "../messaging/session-manager.js";
import type { MessagingConfig } from "../messaging/types.js";

export interface SlackConnectorConfig extends MessagingConfig {
  /** Bot User OAuth Token (xoxb-...) */
  botToken: string;
  /** App-Level Token for Socket Mode (xapp-...) */
  appToken: string;
  /** Channel ID for cron report delivery */
  deliveryChannel?: string;
}

/**
 * Slack connector using Socket Mode (WebSocket, no public URL needed).
 *
 * Behaviors:
 * - DMs: responds to every message
 * - Channels: only responds when @mentioned, replies in threads
 * - Supports multi-turn conversations via SessionManager
 */
export class SlackConnector extends MessagingConnector {
  readonly name = "slack";
  private app: App;
  private slackConfig: SlackConnectorConfig;
  private userCache = new Map<string, string>(); // userId → username

  constructor(config: SlackConnectorConfig, sessionManager: SessionManager) {
    super(config, sessionManager);
    this.slackConfig = config;

    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    this.setupListeners();
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log(`[slack] Connected via Socket Mode`);
  }

  async stop(): Promise<void> {
    await this.app.stop();
    console.log(`[slack] Disconnected`);
  }

  async sendMessage(channelId: string, threadId: string | null, text: string): Promise<string | void> {
    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadId || undefined,
    });
    return result.ts;
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.app.client.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name: emoji,
      });
    } catch {
      // Reaction may already exist or be invalid — non-critical
    }
  }

  async showTyping(channelId: string, messageId: string): Promise<void> {
    // Slack doesn't have a bot typing indicator API.
    // Use 👀 emoji as acknowledgment (same as old Hermes behavior).
    await this.addReaction(channelId, messageId, "eyes");
  }

  /** Send a message to the configured delivery channel (for cron reports) */
  async sendToDeliveryChannel(text: string): Promise<void> {
    if (!this.slackConfig.deliveryChannel) {
      console.warn("[slack] No delivery channel configured");
      return;
    }
    const chunks = this.chunkMessage(text);
    for (const chunk of chunks) {
      await this.sendMessage(this.slackConfig.deliveryChannel, null, chunk);
    }
  }

  private setupListeners(): void {
    // Handle all message events (DMs, channels, groups)
    this.app.message(async ({ message }) => {
      // Filter out non-standard message subtypes (edits, deletes, joins, etc.)
      const msg = message as any;
      if (msg.subtype) return;
      if (!msg.user || !msg.text) return;
      // Ignore bot messages
      if (msg.bot_id) return;

      const username = await this.resolveUsername(msg.user);
      const isDM = msg.channel_type === "im";
      const isMention = this.config.botIdentifier
        ? msg.text.includes(`<@${this.config.botIdentifier}>`)
        : false;

      await this.handleIncomingMessage({
        platformUserId: msg.user,
        platformUsername: username,
        channelId: msg.channel,
        threadId: msg.thread_ts || null,
        messageId: msg.ts,
        text: msg.text,
        isDM,
        isMention,
        raw: msg,
      });
    });

    // Handle explicit @mentions (app_mention event)
    this.app.event("app_mention", async ({ event }) => {
      if (!event.user || !event.text) return;

      const username = await this.resolveUsername(event.user);

      await this.handleIncomingMessage({
        platformUserId: event.user,
        platformUsername: username,
        channelId: event.channel,
        threadId: event.thread_ts || null,
        messageId: event.ts,
        text: event.text,
        isDM: false,
        isMention: true,
        raw: event,
      });
    });
  }

  /** Resolve a Slack user ID to a username (cached) */
  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const username = result.user?.name || result.user?.real_name || userId;
      this.userCache.set(userId, username);
      return username;
    } catch {
      return userId;
    }
  }
}
