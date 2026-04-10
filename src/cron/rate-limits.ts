import type { StateDb } from "../state/db.js";

/** Component name used for the host claude CLI auth state in system_status. */
export const HOST_CLAUDE_AUTH_COMPONENT = "host-claude-auth";

/**
 * Optional notifier — called once when the auth state transitions to degraded.
 * Pass a SlackConnector's `sendToDeliveryChannel` (or any other channel).
 */
export type AdminNotifier = (text: string) => Promise<void>;

/**
 * Check Claude usage limits by making a minimal Agent SDK call
 * and parsing the stream-json output for rate_limit_event and usage data.
 *
 * Works with Claude subscriptions (no API key needed).
 *
 * Behavior:
 * - If the host claude CLI returns "Not logged in" / authentication_failed,
 *   marks `system_status.host-claude-auth` as `degraded`, notifies the admin
 *   on the first transition, and halts subsequent runs until cleared.
 * - The capacity check creates a JSONL session file as a side effect — we
 *   delete it after parsing so it doesn't pollute the dashboard Sessions list.
 */
export async function checkApiUsage(db: StateDb, notifyAdmin?: AdminNotifier): Promise<void> {
  // Halt early if we're already in a degraded state — operator must clear it
  // (e.g. after `claude /login` + recheck) before this cron resumes.
  const existing = db.getSystemStatus(HOST_CLAUDE_AUTH_COMPONENT);
  if (existing?.state === "degraded") {
    console.log(`[usage] Skipping capacity check — host claude auth is degraded since ${existing.since}. Run claude /login on the host and trigger a recheck to resume.`);
    return;
  }

  const now = new Date().toISOString();
  let capacityCheckSessionId = "";
  let authFailed = false;
  let authFailureReason = "";

  // ── Capacity & rate limit check via claude CLI ──
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);

    let stdout = "";
    try {
      const result = await exec("claude", [
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
      stdout = result.stdout;
    } catch (execErr: any) {
      // Non-zero exit (e.g. auth_failed) — claude still emits stream-json on stdout
      stdout = execErr.stdout?.toString() || "";
      if (!stdout) {
        // No output at all — propagate the underlying failure
        throw execErr;
      }
    }

    // Parse each JSON line from the stream output
    for (const line of stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);

        // Capture session id so we can delete the JSONL file afterwards
        if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
          capacityCheckSessionId = msg.session_id;
        }

        // Detect "Not logged in" — claude emits a synthetic assistant message
        // with error: "authentication_failed" when the host CLI has no creds.
        if (msg.type === "assistant" && msg.error === "authentication_failed") {
          authFailed = true;
          const text = msg.message?.content?.[0]?.text || "Not logged in";
          authFailureReason = text;
        }

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
    // The capacity check is best-effort — log and continue. Cleanup + status
    // handling below should still run regardless of the failure mode.
    db.updateRateLimit("subscription:status", 0, now);
    console.warn(`[usage] Capacity check failed: ${err.message}`);
  }

  // If the call surfaced an auth failure, mark the component degraded and
  // notify the admin once on transition. Subsequent runs early-return above.
  if (authFailed) {
    const transitioned = db.setSystemStatus(
      HOST_CLAUDE_AUTH_COMPONENT,
      "degraded",
      authFailureReason || "Host claude CLI is not logged in",
    );
    if (transitioned) {
      console.error(`[usage] Host claude auth is now DEGRADED: ${authFailureReason}`);
      if (notifyAdmin) {
        const msg =
          `:rotating_light: *Last Light: host claude CLI auth degraded*\n` +
          `Reason: ${authFailureReason}\n` +
          `Action: run \`docker exec -it --user lastlight lastlight-agent-1 claude /login\` and then trigger a recheck.\n` +
          `The capacity-check cron is now halted to prevent log spam.`;
        try {
          await notifyAdmin(msg);
        } catch (notifyErr: any) {
          console.error(`[usage] Failed to notify admin: ${notifyErr.message}`);
        }
      }
    }
  } else {
    // Successful run — clear any prior degraded state
    const existing = db.getSystemStatus(HOST_CLAUDE_AUTH_COMPONENT);
    if (existing && existing.state !== "ok") {
      db.setSystemStatus(HOST_CLAUDE_AUTH_COMPONENT, "ok");
      console.log(`[usage] Host claude auth recovered — state cleared`);
      if (notifyAdmin) {
        try {
          await notifyAdmin(`:white_check_mark: Last Light: host claude CLI auth recovered. Capacity-check cron resuming normal operation.`);
        } catch { /* non-fatal */ }
      }
    } else if (!existing) {
      // First-ever successful run — initialize the state
      db.setSystemStatus(HOST_CLAUDE_AUTH_COMPONENT, "ok");
    }
  }

  // Run JSONL cleanup regardless of outcome (try/finally semantics).
  {
    // Delete the session JSONL file the capacity check created so it doesn't
    // pollute the dashboard Sessions list. Best-effort — ignore failures.
    if (capacityCheckSessionId) {
      try {
        const { unlink } = await import("fs/promises");
        const { join } = await import("path");
        const home = process.env.HOME || "/home/lastlight";
        // claude encodes the project's cwd as the directory name, replacing
        // path separators with dashes. e.g. /app -> -app
        const projectDir = process.cwd().replace(/\//g, "-");
        const sessionFile = join(home, ".claude", "projects", projectDir, `${capacityCheckSessionId}.jsonl`);
        await unlink(sessionFile);
      } catch {
        /* file may not exist or claude may not have written it — ignore */
      }
    }
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
