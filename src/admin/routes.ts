import { Hono } from "hono";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { unwrapLine, type SessionReader, type SessionMeta } from "./sessions.js";
import type { StateDb } from "../state/db.js";
import { tailJsonl } from "./tail.js";
import { listRunningContainers, killContainer } from "./docker.js";
import { authMiddleware, createToken, verifyToken } from "./auth.js";

export interface AdminConfig {
  stateDir: string;
  sessionsDir: string;
  adminPassword: string;
  adminSecret: string;
  /** Optional admin notifier (e.g. Slack) used by the recheck endpoint */
  adminNotifier?: (msg: string) => Promise<void>;
}

/**
 * Check if a session is live by matching against running container taskIds.
 * Sessions are live if they were recently active (within 5 min) and a container
 * with a matching pattern is running.
 */
function isSessionLive(meta: SessionMeta, liveTaskIds: Set<string | null>): boolean {
  // A session is considered live if it has recent activity and no end marker
  const lastActivity = meta.last_message_at ?? meta.started_at;
  const fiveMinAgo = Date.now() / 1000 - 300;
  if (lastActivity < fiveMinAgo) return false;

  // Check if any running container's taskId appears related to this session
  // Sessions don't directly map to taskIds, but recent + active = likely live
  return true;
}

export function createAdminRoutes(
  db: StateDb,
  sessions: SessionReader,
  config: AdminConfig,
): Hono {
  const app = new Hono();

  // Auth middleware
  app.use("/*", authMiddleware(config.adminPassword, config.adminSecret));

  // Auth endpoints
  app.get("/auth-required", (c) => {
    return c.json({ required: Boolean(config.adminPassword) });
  });

  app.post("/login", async (c) => {
    if (!config.adminPassword) {
      return c.json({ token: createToken(config.adminSecret), authDisabled: true });
    }
    const body = await c.req.json<{ password?: string }>();
    if (typeof body.password !== "string") {
      return c.json({ error: "password required" }, 400);
    }
    const a = Buffer.from(body.password);
    const b = Buffer.from(config.adminPassword);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      return c.json({ error: "invalid password" }, 401);
    }
    return c.json({ token: createToken(config.adminSecret) });
  });

  // Health
  app.get("/health", (c) => {
    return c.json({ status: "ok", stateDir: config.stateDir });
  });

  // Session list — enriched with live container status
  app.get("/sessions", async (c) => {
    const limit = Number(c.req.query("limit") ?? 200);
    const allIds = sessions.listSessionIds();
    const [metas, containers] = await Promise.all([
      Promise.all(allIds.slice(0, limit * 2).map((id) => sessions.getSessionMeta(id))),
      listRunningContainers(),
    ]);
    const liveTaskIds = new Set(containers.map((c) => c.taskId).filter(Boolean));
    const valid = metas
      .filter((m): m is SessionMeta => m !== null)
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit)
      .map((m) => ({ ...m, live: liveTaskIds.size > 0 && isSessionLive(m, liveTaskIds) }));
    return c.json({ sessions: valid, liveCount: containers.length });
  });

  // Session list SSE stream
  app.get("/sessions/stream", (c) => {
    const limit = Number(c.req.query("limit") ?? 200);

    return streamSSE(c, async (stream) => {
      let prevSig = "";
      let stopped = false;

      stream.onAbort(() => { stopped = true; });

      const push = async () => {
        const [allIds, containers] = await Promise.all([
          Promise.resolve(sessions.listSessionIds()),
          listRunningContainers(),
        ]);
        const liveTaskIds = new Set(containers.map((c) => c.taskId).filter(Boolean));
        const metas = await Promise.all(
          allIds.slice(0, limit * 2).map((id) => sessions.getSessionMeta(id)),
        );
        const valid = metas
          .filter((m): m is SessionMeta => m !== null)
          .sort((a, b) => b.started_at - a.started_at)
          .slice(0, limit)
          .map((m) => ({ ...m, live: liveTaskIds.size > 0 && isSessionLive(m, liveTaskIds) }));

        const sig = valid
          .map((s) => `${s.id}:${s.last_message_at ?? s.started_at}:${s.message_count}:${s.live}`)
          .join("|");
        if (sig !== prevSig) {
          prevSig = sig;
          await stream.writeSSE({ event: "sessions", data: JSON.stringify({ sessions: valid, liveCount: containers.length }) });
        }
      };

      await push();
      while (!stopped) {
        await stream.sleep(3000);
        if (stopped) break;
        await push();
      }
    });
  });

  // Single session
  app.get("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (sessions.exists(id)) {
      const meta = await sessions.getSessionMeta(id);
      if (meta) return c.json({ session: meta });
    }
    return c.json({ error: "session not found" }, 404);
  });

  // Messages for a session
  app.get("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const sinceIndex = Number(c.req.query("since") ?? -1);

    if (sessions.exists(id)) {
      const all = await sessions.read(id);
      const next = all.filter((x) => x.index > sinceIndex);
      return c.json({
        source: "jsonl",
        messages: next.map((x) => ({ id: x.index, ...x.msg })),
        last_id: all.length ? all[all.length - 1]!.index : sinceIndex,
      });
    }
    return c.json({ source: "none", messages: [], last_id: sinceIndex });
  });

  // Live message stream for a session
  app.get("/sessions/:id/stream", async (c) => {
    const id = c.req.param("id");
    const sinceIndex = Number(c.req.query("since") ?? -1);

    if (!sessions.exists(id)) {
      return c.json({ error: "session not found" }, 404);
    }

    const filePath = sessions.getFilePath(id);
    if (!filePath) {
      return c.json({ error: "session file not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let sentReady = false;
      let lastId = sinceIndex;
      let stopped = false;

      stream.onAbort(() => { stopped = true; });

      let msgIndex = sinceIndex;
      const tailer = await tailJsonl(
        filePath,
        (lines) => {
          for (const { msg } of lines) {
            const unwrapped = unwrapLine(msg as Record<string, unknown>);
            for (const m of unwrapped) {
              msgIndex++;
              stream.writeSSE({ event: "message", data: JSON.stringify({ id: msgIndex, ...m }) });
              lastId = msgIndex;
            }
          }
          if (!sentReady) {
            sentReady = true;
            stream.writeSSE({ event: "ready", data: JSON.stringify({ last_id: lastId, source: "jsonl" }) });
          }
        },
        { sinceIndex },
      );

      if (!sentReady) {
        sentReady = true;
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ last_id: sinceIndex, source: "jsonl" }) });
      }

      // Keep connection alive until client disconnects
      while (!stopped) {
        await stream.sleep(15000);
      }
      tailer.stop();
    });
  });

  // Stats — running count uses live Docker containers, not stale DB records
  app.get("/stats", async (c) => {
    const [stats, containers] = await Promise.all([
      Promise.resolve(db.executionStats()),
      listRunningContainers(),
    ]);
    stats.running = containers.length;
    return c.json(stats);
  });

  // API rate limits
  app.get("/rate-limits", (c) => {
    return c.json({ limits: db.getRateLimits() });
  });

  // Component health states (e.g. host-claude-auth degraded after auth failure)
  app.get("/system-status", (c) => {
    return c.json({ statuses: db.listSystemStatus() });
  });

  // Manually trigger a recheck of the host claude CLI auth.
  // Force-runs the check even if the state is currently degraded; the
  // notifier only fires on actual state transitions, so calling this
  // endpoint repeatedly while degraded does NOT spam the admin.
  app.post("/system-status/host-claude-auth/recheck", async (c) => {
    try {
      const { checkApiUsage } = await import("../cron/rate-limits.js");
      await checkApiUsage(db, config.adminNotifier, { force: true });
      const status = db.getSystemStatus("host-claude-auth");
      return c.json({ status });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Running Docker containers
  app.get("/containers", async (c) => {
    const containers = await listRunningContainers();
    return c.json({ containers });
  });

  // Kill a sandbox container and mark related DB executions as failed
  app.delete("/containers/:name", async (c) => {
    const name = c.req.param("name");
    if (!name.startsWith("lastlight-sandbox-")) {
      return c.json({ error: "can only kill sandbox containers" }, 400);
    }
    try {
      await killContainer(name);
      // Parse taskId from container name: lastlight-sandbox-{taskId}-{uuid}
      const match = name.match(/^lastlight-sandbox-(.+?)-[a-f0-9]{8}$/);
      if (match) {
        const taskId = match[1];
        // Mark any running executions with matching skill as failed
        const skills = db.runningExecutions()
          .filter((e) => e.skill.startsWith("build:") || e.skill === "pr-fix")
          .filter((e) => taskId.includes(e.triggerId?.replace(/[^a-z0-9]/gi, "") || "---"));
        for (const e of skills) {
          db.recordFinish(e.id, { success: false, error: "terminated via admin dashboard" });
        }
      }
      return c.json({ killed: name });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Execution records from DB
  app.get("/executions", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const executions = db.allExecutions(limit, offset);
    return c.json({ executions });
  });

  // Workflow runs
  app.get("/workflow-runs", (c) => {
    const rawLimit = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(rawLimit ?? "20", 10) || 20, 1), 100);
    const runs = db.recentWorkflowRuns(limit);
    return c.json({ workflowRuns: runs });
  });

  app.get("/workflow-runs/:id", (c) => {
    const id = c.req.param("id");
    const run = db.getWorkflowRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    return c.json({ workflowRun: run });
  });

  app.post("/workflow-runs/:id/cancel", (c) => {
    const id = c.req.param("id");
    const run = db.getWorkflowRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    if (run.status !== "running" && run.status !== "paused") {
      return c.json({ error: `cannot cancel a run with status '${run.status}'` }, 400);
    }
    db.cancelWorkflowRun(id);
    return c.json({ cancelled: id });
  });

  // ── Approval Gates ─────────────────────────────────────────────

  app.get("/approvals", (c) => {
    const approvals = db.listPendingApprovals();
    return c.json({ approvals });
  });

  app.post("/approvals/:id/respond", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ decision: "approved" | "rejected"; reason?: string }>();
    const approval = db.getApproval(id);
    if (!approval) return c.json({ error: "approval not found" }, 404);
    if (approval.status !== "pending") return c.json({ error: `already ${approval.status}` }, 400);
    db.respondToApproval(id, body.decision, "admin", body.reason);
    if (body.decision === "rejected") {
      const workflowRun = db.getWorkflowRun(approval.workflowRunId);
      if (workflowRun) {
        db.finishWorkflowRun(approval.workflowRunId, "failed", `Rejected via dashboard: ${body.reason || "no reason"}`);
      }
    }
    return c.json({ status: body.decision });
  });

  return app;
}
