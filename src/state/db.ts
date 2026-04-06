import Database from "better-sqlite3";
import { resolve } from "path";

const DEFAULT_DB_PATH = "lastlight.db";

export interface ExecutionRecord {
  id: string;
  triggerType: "webhook" | "cron";
  triggerId: string;
  skill: string;
  repo?: string;
  issueNumber?: number;
  startedAt: string;
  finishedAt?: string;
  success?: boolean;
  error?: string;
  turns?: number;
  durationMs?: number;
}

/**
 * Lightweight SQLite state for operational tracking.
 * NOT for conversation history — only execution logs and rate limits.
 */
export class StateDb {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(resolve(dbPath || DEFAULT_DB_PATH));
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        skill TEXT NOT NULL,
        repo TEXT,
        issue_number INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        success INTEGER,
        error TEXT,
        turns INTEGER,
        duration_ms INTEGER
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        resource TEXT PRIMARY KEY,
        remaining INTEGER,
        reset_at TEXT,
        updated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_executions_trigger ON executions(trigger_type, trigger_id);
      CREATE INDEX IF NOT EXISTS idx_executions_skill ON executions(skill, started_at);
    `);
  }

  recordStart(record: Omit<ExecutionRecord, "finishedAt" | "success" | "error" | "turns" | "durationMs">): void {
    this.db.prepare(`
      INSERT INTO executions (id, trigger_type, trigger_id, skill, repo, issue_number, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.triggerType,
      record.triggerId,
      record.skill,
      record.repo,
      record.issueNumber,
      record.startedAt
    );
  }

  recordFinish(id: string, result: { success: boolean; error?: string; turns?: number; durationMs?: number }): void {
    this.db.prepare(`
      UPDATE executions
      SET finished_at = ?, success = ?, error = ?, turns = ?, duration_ms = ?
      WHERE id = ?
    `).run(
      new Date().toISOString(),
      result.success ? 1 : 0,
      result.error,
      result.turns,
      result.durationMs,
      id
    );
  }

  /** Check if a skill is currently running for a given trigger */
  isRunning(skill: string, triggerId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM executions
      WHERE skill = ? AND trigger_id = ? AND finished_at IS NULL
      LIMIT 1
    `).get(skill, triggerId);
    return !!row;
  }

  /** Get recent executions for a skill */
  recentExecutions(skill: string, limit = 10): ExecutionRecord[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE skill = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(skill, limit) as ExecutionRecord[];
  }

  /** Count consecutive failures for a skill (for cron failure tracking) */
  consecutiveFailures(skill: string): number {
    const rows = this.db.prepare(`
      SELECT success FROM executions
      WHERE skill = ? AND finished_at IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 10
    `).all(skill) as { success: number }[];

    let count = 0;
    for (const row of rows) {
      if (row.success === 0) count++;
      else break;
    }
    return count;
  }

  /** Update rate limit state */
  updateRateLimit(resource: string, remaining: number, resetAt: string): void {
    this.db.prepare(`
      INSERT INTO rate_limits (resource, remaining, reset_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(resource) DO UPDATE SET remaining = ?, reset_at = ?, updated_at = ?
    `).run(resource, remaining, resetAt, new Date().toISOString(), remaining, resetAt, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
