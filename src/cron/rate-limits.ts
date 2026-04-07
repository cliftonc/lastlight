import type { StateDb } from "../state/db.js";

/**
 * Check Claude usage limits by making a minimal Agent SDK call
 * and parsing the stream-json output for rate_limit_event and usage data.
 *
 * Works with Claude subscriptions (no API key needed).
 */
export async function checkApiUsage(db: StateDb): Promise<void> {
  const now = new Date().toISOString();

  // ── Capacity & rate limit check via claude CLI ──
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);

    const { stdout } = await exec("claude", [
      "--print", "reply with just: ok",
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", "1",
      "--model", process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      "--bare",
    ], {
      timeout: 30_000,
      env: { ...process.env, HOME: process.env.HOME || "/home/lastlight" },
    });

    // Parse each JSON line from the stream output
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);

        // Rate limit info from subscription
        if (msg.type === "rate_limit_event" && msg.rate_limit_info) {
          const info = msg.rate_limit_info;
          db.updateRateLimit("subscription:status", info.status === "allowed" ? 1 : 0, now);
          db.updateRateLimit("subscription:type", 0, info.rateLimitType || "unknown");

          if (info.resetsAt) {
            db.updateRateLimit("subscription:resets_at", info.resetsAt, new Date(info.resetsAt * 1000).toISOString());
          }
          if (info.overageStatus) {
            db.updateRateLimit("subscription:overage_status", info.overageStatus === "allowed" ? 1 : 0, now);
          }
          if (info.overageResetsAt) {
            db.updateRateLimit("subscription:overage_resets_at", info.overageResetsAt, new Date(info.overageResetsAt * 1000).toISOString());
          }
          db.updateRateLimit("subscription:using_overage", info.isUsingOverage ? 1 : 0, now);

          console.log(`[usage] Subscription: ${info.status}, type=${info.rateLimitType}, overage=${info.isUsingOverage ? "yes" : "no"} (${info.overageStatus})`);
        }

        // Result with cost and usage breakdown
        if (msg.type === "result") {
          if (msg.total_cost_usd !== undefined) {
            // Store as cents to keep as integer
            db.updateRateLimit("usage:last_check_cost_cents", Math.round(msg.total_cost_usd * 100), now);
          }
          if (msg.usage) {
            db.updateRateLimit("usage:last_check_input_tokens", msg.usage.input_tokens || 0, now);
            db.updateRateLimit("usage:last_check_output_tokens", msg.usage.output_tokens || 0, now);
          }
        }
      } catch { /* skip unparseable lines */ }
    }
  } catch (err: any) {
    const isRateLimit = /rate.?limit|too many|capacity|throttl/i.test(err.message);
    db.updateRateLimit("subscription:status", 0, now);
    console.warn(`[usage] Capacity check failed: ${err.message}`);
    if (!isRateLimit) throw err;
  }

  // ── Usage stats from our own execution records ──
  try {
    const stats = computeUsageStats(db);
    db.updateRateLimit("usage:executions_1h", stats.lastHour, now);
    db.updateRateLimit("usage:executions_24h", stats.last24h, now);
    db.updateRateLimit("usage:turns_1h", stats.turnsLastHour, now);
    db.updateRateLimit("usage:turns_24h", stats.turnsLast24h, now);
    console.log(
      `[usage] Last 1h: ${stats.lastHour} executions, ${stats.turnsLastHour} turns | ` +
      `24h: ${stats.last24h} executions, ${stats.turnsLast24h} turns`
    );
  } catch (err: any) {
    console.error(`[usage] Stats computation failed: ${err.message}`);
  }
}

function computeUsageStats(db: StateDb) {
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const raw = db.database;

  const h1 = raw.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(turns), 0) as turns
    FROM executions WHERE started_at >= ?
  `).get(oneHourAgo) as { count: number; turns: number };

  const h24 = raw.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(turns), 0) as turns
    FROM executions WHERE started_at >= ?
  `).get(oneDayAgo) as { count: number; turns: number };

  return {
    lastHour: h1.count,
    turnsLastHour: h1.turns,
    last24h: h24.count,
    turnsLast24h: h24.turns,
  };
}
