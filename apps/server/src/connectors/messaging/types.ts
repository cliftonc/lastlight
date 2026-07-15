/**
 * Shared types for messaging platform connectors (Slack, Discord, Teams, etc.).
 * Platform-specific connectors extend MessagingConfig and implement
 * the abstract methods in MessagingConnector.
 */

/** Base config shared by all messaging connectors */
export interface MessagingConfig {
  /** Platform user IDs allowed to interact with the bot */
  allowedUsers: string[];
  /** Bot's identifier for @mention detection (platform-specific format) */
  botIdentifier: string;
}

/** Unique key identifying a conversation thread */
export interface ConversationKey {
  /** Platform name (e.g., "slack", "discord") */
  platform: string;
  /** Platform-specific channel/DM identifier */
  channelId: string;
  /** Thread identifier (null for top-level DMs) */
  threadId: string | null;
  /** User who initiated */
  userId: string;
}

/** Persisted conversation session */
export interface ConversationSession {
  id: string;
  platform: string;
  channelId: string;
  threadId: string | null;
  userId: string;
  /** Agent SDK session ID for multi-turn context (reserved for future use) */
  agentSessionId: string | null;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  active: boolean;
}

/** A single message in a conversation */
export interface ConversationMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  platformMessageId: string | null;
}

/** Parameters passed from platform connector to handleIncomingMessage() */
export interface IncomingMessageParams {
  platformUserId: string;
  platformUsername: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  text: string;
  isDM: boolean;
  isMention: boolean;
  raw: unknown;
}
