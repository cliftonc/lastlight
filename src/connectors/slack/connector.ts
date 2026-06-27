import { App } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { createHmac, timingSafeEqual } from "crypto";
import type { Hono } from "hono";
import { MessagingConnector } from "../messaging/base.js";
import type { SessionManager } from "../messaging/session-manager.js";
import type { MessagingConfig } from "../messaging/types.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";

/** Rotating status messages shown while the agent is thinking */
const THINKING_MESSAGES = [
  "Thinking...",
  "Pondering the cosmos...",
  "Consulting the codebase...",
  "Rummaging through repos...",
  "Brewing a response...",
  "Crunching context...",
  "Reading between the lines...",
  "Warming up the neurons...",
  "Assembling thoughts...",
  "Almost there...",
];

export interface SlackConnectorConfig extends MessagingConfig {
  /** Bot User OAuth Token (xoxb-…) — used for all Web API calls (sending). */
  botToken: string;
  /** How events are received. */
  mode: "webhook" | "socket";
  /** App-Level Token for Socket Mode (xapp-…). Required when mode === "socket". */
  appToken?: string;
  /** Events API signing secret. Required when mode === "webhook". */
  signingSecret?: string;
  /** Channel ID for cron report delivery */
  deliveryChannel?: string;
  /**
   * Shared Hono app to mount `POST /webhooks/slack` on (webhook mode). This is
   * the same HTTP server the GitHub webhook + /api/chat already run on. Must be
   * present in webhook mode.
   */
  honoApp?: Hono;
}

/**
 * Slack connector. Two receive modes:
 *
 * - **webhook** (default/prod): the HTTP Events API. Slack POSTs to
 *   `/webhooks/slack`; we verify the signing-secret signature, answer the
 *   one-time url_verification handshake, dedup retries by `event_id`, and ack
 *   within Slack's 3s window while processing async. Slack retries failed
 *   deliveries, so this is at-least-once — it does not silently drop messages
 *   the way Socket Mode does.
 * - **socket** (dev fallback): Socket Mode over a WebSocket, no public URL
 *   needed. At-most-once; kept only for local development.
 *
 * Sending is identical in both modes via a `WebClient`.
 *
 * Behaviors:
 * - DMs: responds to every message (subscribe `message.im` in webhook mode)
 * - Channels: only responds when @mentioned (subscribe `app_mention`)
 */
export class SlackConnector extends MessagingConnector {
  readonly name = "slack";
  /** Web API client for sending — used in both modes. */
  private web: WebClient;
  /** Bolt app — constructed only in socket mode, purely as the receiver. */
  private bolt: App | null = null;
  private slackConfig: SlackConnectorConfig;
  private userCache = new Map<string, string>(); // userId → username
  /** Bounded set of processed Events API delivery ids, to drop Slack retries. */
  private seenEventIds = new Set<string>();
  private seenEventOrder: string[] = [];

  constructor(config: SlackConnectorConfig, sessionManager: SessionManager) {
    super(config, sessionManager);
    this.slackConfig = config;
    this.web = new WebClient(config.botToken);

    if (config.mode === "socket") {
      if (!config.appToken) throw new Error("[slack] socket mode requires appToken");
      this.bolt = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
      });
      this.setupSocketListeners();
    } else {
      if (!config.honoApp) {
        throw new Error(
          "[slack] webhook mode requires an HTTP server to mount /webhooks/slack on " +
          "(none available — is the GitHub webhook connector configured?). " +
          "Set SLACK_MODE=socket for a standalone Slack deployment.",
        );
      }
      if (!config.signingSecret) throw new Error("[slack] webhook mode requires signingSecret");
      this.mountWebhookRoute(config.honoApp);
    }
  }

  async start(): Promise<void> {
    if (this.bolt) {
      await this.bolt.start();
      console.log(`[slack] Connected via Socket Mode`);
    } else {
      console.log(`[slack] Listening via HTTP Events API at /webhooks/slack`);
    }
  }

  async stop(): Promise<void> {
    if (this.bolt) {
      await this.bolt.stop();
      console.log(`[slack] Disconnected`);
    }
    // Webhook mode shares the GitHub connector's HTTP server; nothing to stop.
  }

  async sendMessage(channelId: string, threadId: string | null, text: string): Promise<string | void> {
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text: markdownToSlackMrkdwn(text),
      thread_ts: threadId || undefined,
    });
    return result.ts;
  }

  /**
   * Edit a previously-sent message in place (`chat.update`). Paired with the
   * `ts` returned by `sendMessage`, this powers the single in-place status
   * checklist (see `src/notify/transports/slack.ts`) so a workflow's progress
   * updates one message instead of flooding the thread. Note: `chat.update` is
   * silent — it does not re-notify — so a separate terminal message is posted
   * at the end for an actual ping.
   */
  async updateMessage(channelId: string, ts: string, text: string): Promise<void> {
    await this.web.chat.update({
      channel: channelId,
      ts,
      text: markdownToSlackMrkdwn(text),
    });
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.add({
        channel: channelId,
        timestamp: messageId,
        name: emoji,
      });
    } catch {
      // Reaction may already exist or be invalid — non-critical
    }
  }

  async showTyping(channelId: string, messageId: string, threadRootId: string): Promise<void> {
    // Use Slack's assistant.threads.setStatus with rotating fun messages.
    // thread_ts MUST be the thread root — passing the new reply's ts in an
    // existing thread silently errors and the indicator never shows.
    try {
      await this.web.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadRootId,
        status: "Thinking...",
        loading_messages: THINKING_MESSAGES,
      });
    } catch {
      // Assistant API not available — fall back to an emoji reaction on
      // the user's actual message (not the thread root).
      await this.addReaction(channelId, messageId, "eyes");
    }
  }

  /** Clear the thinking status after processing completes */
  async clearTyping(channelId: string, threadId: string): Promise<void> {
    try {
      await this.web.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadId,
        status: "",
      });
    } catch {
      // Non-critical — status will clear on its own
    }
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

  // ── Webhook (HTTP Events API) receiver ─────────────────────────────────

  /**
   * Mount `POST /webhooks/slack` on the shared Hono app. Verifies the request
   * signature, handles the url_verification handshake, dedups retries, and
   * acks fast while processing the event asynchronously.
   */
  private mountWebhookRoute(app: Hono): void {
    app.post("/webhooks/slack", async (c) => {
      const body = await c.req.text();
      const timestamp = c.req.header("x-slack-request-timestamp") || "";
      const signature = c.req.header("x-slack-signature") || "";
      if (!verifySlackSignature(body, timestamp, signature, this.slackConfig.signingSecret!)) {
        return c.json({ error: "Invalid signature" }, 401);
      }

      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      // One-time handshake when (re)configuring the Request URL in the Slack app.
      if (payload.type === "url_verification") {
        return c.json({ challenge: payload.challenge });
      }

      if (payload.type === "event_callback") {
        const eventId = typeof payload.event_id === "string" ? payload.event_id : undefined;
        // Slack retries on any non-200 / >3s; dedup so a retry of an event we
        // already accepted is a no-op rather than a double-processed message.
        if (eventId && this.markSeen(eventId)) {
          return c.body(null, 200);
        }
        const event = payload.event;
        // Ack immediately, process async — never hold the response past 3s or
        // Slack will retry (and we'd handle it twice if it slipped past dedup).
        setImmediate(() => {
          this.dispatchSlackEvent(event).catch((err) =>
            console.error("[slack] event handler error:", err),
          );
        });
      }

      return c.body(null, 200);
    });
  }

  /** Route a raw Events API `event` object to the right handler. */
  private async dispatchSlackEvent(event: any): Promise<void> {
    if (!event || typeof event !== "object") return;
    if (event.type === "message") {
      await this.onMessageEvent(event);
    } else if (event.type === "app_mention") {
      await this.onAppMention(event);
    }
  }

  /**
   * Record an Events API delivery id as seen. Returns true if it was already
   * seen (a Slack retry). Bounded to the most recent ~1000 ids.
   */
  private markSeen(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return true;
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    if (this.seenEventOrder.length > 1000) {
      const evicted = this.seenEventOrder.shift();
      if (evicted) this.seenEventIds.delete(evicted);
    }
    return false;
  }

  // ── Socket Mode receiver (dev fallback) ────────────────────────────────

  private setupSocketListeners(): void {
    // Handle all message events (DMs, channels, groups)
    this.bolt!.message(async ({ message }) => {
      await this.onMessageEvent(message as any);
    });

    // Handle explicit @mentions (app_mention event)
    this.bolt!.event("app_mention", async ({ event }) => {
      await this.onAppMention(event as any);
    });
  }

  // ── Shared event handling (both modes feed these) ──────────────────────

  /** A raw Slack `message` event (DM or channel). */
  private async onMessageEvent(msg: any): Promise<void> {
    // Log EVERY inbound message before any filtering. When a DM looks like it
    // "dropped" messages, this line tells us whether Slack delivered the event
    // at all and, if so, why we ignored it (a subtype like message_changed, a
    // bot_id, or empty text) — versus Slack never sending it.
    console.log(
      `[slack] inbound msg ch=${msg.channel ?? "-"} ts=${msg.ts ?? "-"} ` +
      `thread_ts=${msg.thread_ts ?? "-"} subtype=${msg.subtype ?? "-"} ` +
      `bot_id=${msg.bot_id ?? "-"} channel_type=${msg.channel_type ?? "-"} ` +
      `user=${msg.user ?? "-"} hasText=${msg.text ? "y" : "n"}`,
    );
    // Filter out non-standard message subtypes (edits, deletes, joins, etc.)
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
  }

  /** A raw Slack `app_mention` event (always a channel mention). */
  private async onAppMention(event: any): Promise<void> {
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
  }

  /** Resolve a Slack user ID to a username (cached) */
  private async resolveUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.web.users.info({ user: userId });
      const username = result.user?.name || result.user?.real_name || userId;
      this.userCache.set(userId, username);
      return username;
    } catch {
      return userId;
    }
  }
}

/**
 * Verify a Slack Events API request signature.
 *
 * Slack signs `v0:{timestamp}:{rawBody}` with the app's signing secret and
 * sends it as `x-slack-signature: v0=…`. We recompute and compare in constant
 * time, and reject requests whose timestamp is more than 5 minutes off (replay
 * protection). `now` is injectable for tests. Exported for unit testing.
 */
export function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
  now: number = Date.now(),
): boolean {
  if (!timestamp || !signature || !signingSecret) return false;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > 300) return false; // 5-minute replay window

  const expected = "v0=" + createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
