import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { ConversationKey, ConversationSession, ConversationMessage } from "./types.js";

/** Inactivity timeout before a session is considered stale (30 minutes) */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * SQLite-backed session manager for messaging conversations.
 * Shared across all messaging platform connectors.
 */
export class SessionManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messaging_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        agent_session_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        UNIQUE(platform, channel_id, thread_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS messaging_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES messaging_sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        platform_message_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
        ON messaging_sessions(platform, channel_id, thread_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_msg_messages_session
        ON messaging_messages(session_id, timestamp);
    `);
  }

  /** Get an existing active session or create a new one */
  getOrCreateSession(key: ConversationKey): ConversationSession {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();

    // Look for an active, non-stale session
    const existing = this.db.prepare(`
      SELECT * FROM messaging_sessions
      WHERE platform = ? AND channel_id = ? AND thread_id IS ? AND user_id = ?
        AND active = 1 AND last_activity_at >= ?
    `).get(key.platform, key.channelId, key.threadId, key.userId, cutoff) as any;

    if (existing) {
      return this.rowToSession(existing);
    }

    // Deactivate any stale sessions for this key
    this.db.prepare(`
      UPDATE messaging_sessions SET active = 0
      WHERE platform = ? AND channel_id = ? AND thread_id IS ? AND user_id = ? AND active = 1
    `).run(key.platform, key.channelId, key.threadId, key.userId);

    // Create new session
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO messaging_sessions (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, key.platform, key.channelId, key.threadId, key.userId, now, now);

    return {
      id,
      platform: key.platform,
      channelId: key.channelId,
      threadId: key.threadId,
      userId: key.userId,
      agentSessionId: null,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      active: true,
    };
  }

  /** Update last activity timestamp and increment message count */
  touchSession(id: string): void {
    this.db.prepare(`
      UPDATE messaging_sessions
      SET last_activity_at = ?, message_count = message_count + 1
      WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  /** Deactivate a session (e.g., user sends /new or /reset) */
  deactivateSession(id: string): void {
    this.db.prepare(`UPDATE messaging_sessions SET active = 0 WHERE id = ?`).run(id);
  }

  /** Store a message in the conversation history */
  addMessage(sessionId: string, role: "user" | "assistant", content: string, platformMessageId?: string): void {
    this.db.prepare(`
      INSERT INTO messaging_messages (session_id, role, content, timestamp, platform_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, new Date().toISOString(), platformMessageId || null);
  }

  /** Get conversation history for a session (most recent N messages) */
  getHistory(sessionId: string, limit = 50): ConversationMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messaging_messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(sessionId, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      platformMessageId: r.platform_message_id,
    }));
  }

  /** Clean up old inactive sessions (call from cron) */
  cleanupStaleSessions(maxAgeDays = 7): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    // Delete messages for old sessions first
    this.db.prepare(`
      DELETE FROM messaging_messages WHERE session_id IN (
        SELECT id FROM messaging_sessions WHERE active = 0 AND last_activity_at < ?
      )
    `).run(cutoff);

    const result = this.db.prepare(`
      DELETE FROM messaging_sessions WHERE active = 0 AND last_activity_at < ?
    `).run(cutoff);

    return result.changes;
  }

  private rowToSession(row: any): ConversationSession {
    return {
      id: row.id,
      platform: row.platform,
      channelId: row.channel_id,
      threadId: row.thread_id,
      userId: row.user_id,
      agentSessionId: row.agent_session_id,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      active: !!row.active,
    };
  }
}
