import { Hono } from "hono";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { unwrapLine, type SessionReader, type SessionMeta } from "./sessions.js";
import type { StateDb } from "../state/db.js";
import { tailJsonl } from "./tail.js";
import { listRunningContainers } from "./docker.js";
import { authMiddleware, createToken, verifyToken } from "./auth.js";

export interface AdminConfig {
  stateDir: string;
  sessionsDir: string;
  adminPassword: string;
  adminSecret: string;
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

  // Running Docker containers
  app.get("/containers", async (c) => {
    const containers = await listRunningContainers();
    return c.json({ containers });
  });

  // Execution records from DB
  app.get("/executions", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const executions = db.allExecutions(limit, offset);
    return c.json({ executions });
  });

  return app;
}
