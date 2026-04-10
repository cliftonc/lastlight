import Database from "better-sqlite3";
import { resolve } from "path";

const DEFAULT_DB_PATH = "lastlight.db";

export interface ExecutionRecord {
  id: string;
  triggerType: "webhook" | "cron" | "chat" | "api";
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

      CREATE TABLE IF NOT EXISTS system_status (
        component TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        reason TEXT,
        since TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

  /** Check if a skill has already completed successfully for a given trigger */
  isCompleted(skill: string, triggerId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM executions
      WHERE skill = ? AND trigger_id = ? AND success = 1
      LIMIT 1
    `).get(skill, triggerId);
    return !!row;
  }

  /** Check if a phase should run: not currently running AND not already succeeded */
  shouldRunPhase(skill: string, triggerId: string): "run" | "running" | "done" {
    const running = this.db.prepare(`
      SELECT 1 FROM executions
      WHERE skill = ? AND trigger_id = ? AND finished_at IS NULL
      LIMIT 1
    `).get(skill, triggerId);
    if (running) return "running";

    const done = this.db.prepare(`
      SELECT 1 FROM executions
      WHERE skill = ? AND trigger_id = ? AND success = 1
      LIMIT 1
    `).get(skill, triggerId);
    if (done) return "done";

    return "run";
  }

  /** Mark all stale "running" executions for a skill/trigger as failed.
   *  Called when we detect no matching Docker container is alive. */
  markStaleAsFailed(skill: string, triggerId: string): number {
    const result = this.db.prepare(`
      UPDATE executions
      SET finished_at = ?, success = 0, error = 'stale: container no longer running'
      WHERE skill = ? AND trigger_id = ? AND finished_at IS NULL
    `).run(new Date().toISOString(), skill, triggerId);
    return result.changes;
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

  /** Get all rate limit records */
  getRateLimits(): Array<{ resource: string; remaining: number; reset_at: string; updated_at: string }> {
    return this.db.prepare(`
      SELECT resource, remaining, reset_at, updated_at FROM rate_limits
      ORDER BY resource
    `).all() as Array<{ resource: string; remaining: number; reset_at: string; updated_at: string }>;
  }

  // ── System status (component health tracking) ──

  /**
   * Get the current state of a system component.
   * Returns null if the component has never reported.
   */
  getSystemStatus(component: string): { state: string; reason: string | null; since: string; updated_at: string } | null {
    const row = this.db.prepare(`
      SELECT state, reason, since, updated_at FROM system_status WHERE component = ?
    `).get(component) as { state: string; reason: string | null; since: string; updated_at: string } | undefined;
    return row || null;
  }

  /**
   * Set the state of a system component. If the new state differs from the
   * current state, updates `since` to now (transition timestamp). Returns
   * true on transition (state changed), false on refresh (state unchanged).
   */
  setSystemStatus(component: string, state: string, reason?: string): boolean {
    const now = new Date().toISOString();
    const existing = this.getSystemStatus(component);
    const transitioned = !existing || existing.state !== state;
    const since = transitioned ? now : existing!.since;

    this.db.prepare(`
      INSERT INTO system_status (component, state, reason, since, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(component) DO UPDATE SET
        state = excluded.state,
        reason = excluded.reason,
        since = excluded.since,
        updated_at = excluded.updated_at
    `).run(component, state, reason || null, since, now);

    return transitioned;
  }

  /** List all known component statuses. */
  listSystemStatus(): Array<{ component: string; state: string; reason: string | null; since: string; updated_at: string }> {
    return this.db.prepare(`
      SELECT component, state, reason, since, updated_at FROM system_status
      ORDER BY component
    `).all() as Array<{ component: string; state: string; reason: string | null; since: string; updated_at: string }>;
  }

  /** Get all executions with pagination */
  allExecutions(limit = 100, offset = 0): ExecutionRecord[] {
    return this.db.prepare(`
      SELECT * FROM executions
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as ExecutionRecord[];
  }

  /** Get currently running executions (no finished_at) */
  runningExecutions(): ExecutionRecord[] {
    return this.db.prepare(`
      SELECT * FROM executions
      WHERE finished_at IS NULL
      ORDER BY started_at DESC
    `).all() as ExecutionRecord[];
  }

  /** Aggregate execution stats */
  executionStats(): {
    total_executions: number;
    today_count: number;
    by_skill: Record<string, { count: number; success: number; fail: number }>;
    by_trigger: Record<string, number>;
    running: number;
  } {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = today.toISOString();

    const total = (this.db.prepare(`SELECT COUNT(*) as c FROM executions`).get() as { c: number }).c;
    const todayCount = (this.db.prepare(`SELECT COUNT(*) as c FROM executions WHERE started_at >= ?`).get(todayIso) as { c: number }).c;
    const running = (this.db.prepare(`SELECT COUNT(*) as c FROM executions WHERE finished_at IS NULL`).get() as { c: number }).c;

    const skillRows = this.db.prepare(`
      SELECT skill, COUNT(*) as count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail
      FROM executions GROUP BY skill
    `).all() as { skill: string; count: number; success: number; fail: number }[];

    const by_skill: Record<string, { count: number; success: number; fail: number }> = {};
    for (const r of skillRows) {
      by_skill[r.skill] = { count: r.count, success: r.success, fail: r.fail };
    }

    const triggerRows = this.db.prepare(`
      SELECT trigger_type, COUNT(*) as count FROM executions GROUP BY trigger_type
    `).all() as { trigger_type: string; count: number }[];

    const by_trigger: Record<string, number> = {};
    for (const r of triggerRows) {
      by_trigger[r.trigger_type] = r.count;
    }

    return { total_executions: total, today_count: todayCount, by_skill, by_trigger, running };
  }

  /** Expose the underlying Database instance (for SessionManager, etc.) */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
