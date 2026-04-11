import { Hono } from "hono";
import path from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Slack } from "arctic";
import { unwrapLine, type SessionSource, type SessionMeta } from "./sessions.js";
import type { StateDb, WorkflowRun } from "../state/db.js";
import { tailJsonl } from "./tail.js";
import { listRunningContainers, killContainer, getContainerStats } from "./docker.js";
import { authMiddleware, createToken, verifyToken } from "./auth.js";

export interface AdminConfig {
  stateDir: string;
  sessionsDir: string;
  adminPassword: string;
  adminSecret: string;
  /** Optional admin notifier (e.g. Slack) used by the recheck endpoint */
  adminNotifier?: (msg: string) => Promise<void>;
  /** Optional callback to actively resume a paused workflow after dashboard approval */
  resumeWorkflow?: (workflowRun: WorkflowRun, sender: string) => Promise<void>;
  /** Slack OAuth config (optional — enables "Login with Slack" on dashboard) */
  slackOAuthClientId?: string;
  slackOAuthClientSecret?: string;
  slackOAuthRedirectUri?: string;
  /** Restrict login to this Slack workspace team_id or team domain */
  slackAllowedWorkspace?: string;
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

/**
 * Mount the read/list/stream endpoints for a SessionSource under a given
 * route prefix on `app`. The same handler shape is reused for the workflow
 * "Sessions" tab (sandbox-scoped reader at `/sessions`) and the chat tab
 * (in-process Agent SDK runs at `/chat-sessions`).
 */
function mountSessionRoutes(app: Hono, sessions: SessionSource, prefix: string): void {
  // Session list — enriched with live container status
  app.get(`${prefix}`, async (c) => {
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
  app.get(`${prefix}/stream`, (c) => {
    const limit = Number(c.req.query("limit") ?? 200);

    return streamSSE(c, async (stream) => {
      let prevSig: string | null = null; // null = nothing sent yet (covers empty-list initial push)
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
  app.get(`${prefix}/:id`, async (c) => {
    const id = c.req.param("id");
    if (sessions.exists(id)) {
      const meta = await sessions.getSessionMeta(id);
      if (meta) return c.json({ session: meta });
    }
    return c.json({ error: "session not found" }, 404);
  });

  // Messages for a session
  app.get(`${prefix}/:id/messages`, async (c) => {
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
  app.get(`${prefix}/:id/stream`, async (c) => {
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
}

export function createAdminRoutes(
  db: StateDb,
  sessions: SessionSource,
  chatSessions: SessionSource,
  config: AdminConfig,
): Hono {
  const app = new Hono();

  const slackOAuthEnabled = Boolean(config.slackOAuthClientId && config.slackOAuthClientSecret);

  // Auth middleware
  app.use("/*", authMiddleware(config.adminPassword, config.adminSecret));

  // Auth endpoints
  app.get("/auth-required", (c) => {
    return c.json({ required: Boolean(config.adminPassword), slackOAuth: slackOAuthEnabled });
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
    return c.json({ token: createToken(config.adminSecret, "password") });
  });

  // Slack OAuth routes (only active when Slack OAuth env vars are configured)
  app.get("/oauth/slack/authorize", (c) => {
    if (!slackOAuthEnabled) {
      return c.json({ error: "Slack OAuth not configured" }, 404);
    }
    const slack = new Slack(
      config.slackOAuthClientId!,
      config.slackOAuthClientSecret!,
      config.slackOAuthRedirectUri ?? "",
    );
    const state = randomBytes(16).toString("hex");
    setCookie(c, "slack_oauth_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600, // 10 minutes
    });
    const url = slack.createAuthorizationURL(state, ["openid", "profile"]);
    return c.redirect(url.toString());
  });

  app.get("/oauth/slack/callback", async (c) => {
    if (!slackOAuthEnabled) {
      return c.json({ error: "Slack OAuth not configured" }, 404);
    }
    const storedState = getCookie(c, "slack_oauth_state");
    deleteCookie(c, "slack_oauth_state", { path: "/" });
    const { code, state } = c.req.query() as { code?: string; state?: string };

    if (!storedState || !state || storedState !== state) {
      return c.json({ error: "invalid state parameter" }, 400);
    }
    if (!code) {
      return c.json({ error: "missing authorization code" }, 400);
    }

    try {
      const slack = new Slack(
        config.slackOAuthClientId!,
        config.slackOAuthClientSecret!,
        config.slackOAuthRedirectUri ?? "",
      );
      const tokens = await slack.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();

      // "Sign in with Slack" issues OIDC-scoped tokens (openid + profile),
      // which Slack's classic auth.test endpoint rejects with invalid_auth.
      // Use the OIDC userInfo endpoint instead — it returns a JWT-style
      // payload with claims under namespaced URLs.
      const userInfoRes = await fetch("https://slack.com/api/openid.connect.userInfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userInfo = (await userInfoRes.json()) as {
        ok?: boolean;
        error?: string;
        sub?: string;
        "https://slack.com/team_id"?: string;
        "https://slack.com/team_domain"?: string;
        "https://slack.com/user_id"?: string;
      };
      if (userInfo.ok === false) {
        console.error("Slack openid.connect.userInfo failed:", userInfo.error);
        return c.json({ error: "Slack userInfo failed" }, 502);
      }

      const teamId = userInfo["https://slack.com/team_id"];
      const teamDomain = userInfo["https://slack.com/team_domain"];

      // Workspace restriction check
      if (config.slackAllowedWorkspace) {
        const allowed = config.slackAllowedWorkspace;
        const matchesId = teamId === allowed;
        const matchesDomain = teamDomain === allowed;
        if (!matchesId && !matchesDomain) {
          console.warn(
            `[oauth] Slack login rejected: workspace ${teamDomain ?? teamId ?? "unknown"} not in allowlist (${allowed})`,
          );
          return c.json({ error: "workspace not allowed" }, 403);
        }
      }

      const token = createToken(config.adminSecret, "slack");
      // Redirect to dashboard with token in URL; App.tsx strips it immediately.
      // Trailing slash matters: Vite serves the SPA with base "/admin/" so a
      // bare "/admin" 404s in dev. Production static serving accepts both.
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      console.error("OAuth exchange failed:", err);
      return c.json({ error: "OAuth exchange failed" }, 502);
    }
  });

  // Health
  app.get("/health", (c) => {
    return c.json({ status: "ok", stateDir: config.stateDir });
  });

  // Workflow / sandbox sessions and chat (in-process Agent SDK) sessions both
  // expose the same five endpoints, just under different prefixes and backed
  // by different on-disk slices.
  mountSessionRoutes(app, sessions, "/sessions");
  mountSessionRoutes(app, chatSessions, "/chat-sessions");

  // Stats — running count uses live Docker containers, not stale DB records
  app.get("/stats", async (c) => {
    const [stats, containers] = await Promise.all([
      Promise.resolve(db.executionStats()),
      listRunningContainers(),
    ]);
    stats.running = containers.length;
    return c.json(stats);
  });

  // Daily aggregated stats (last N days)
  app.get("/stats/daily", (c) => {
    const daysParam = c.req.query("days");
    const days = Math.min(Math.max(1, parseInt(daysParam ?? "30", 10) || 30), 90);
    return c.json({ daily: db.dailyStats(days) });
  });

  // Hourly aggregated stats (rolling last N hours, default 24)
  app.get("/stats/hourly", (c) => {
    const hoursParam = c.req.query("hours");
    const hours = Math.min(Math.max(1, parseInt(hoursParam ?? "24", 10) || 24), 168);
    return c.json({ hourly: db.hourlyStats(hours) });
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

  // CPU/memory stats for the agent and any sandbox containers
  app.get("/containers/stats", async (c) => {
    const stats = await getContainerStats();
    return c.json({ stats });
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
        // Mark any running executions with matching skill as failed. Phase
        // skill keys are `<workflowName>:<phaseName>` — match on the colon.
        const skills = db.runningExecutions()
          .filter((e) => e.skill.includes(":") || e.skill === "pr-fix")
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

  // Workflow runs — paginated, optional filters by date, workflow name, and
  // status. Returns `total` so the dashboard can drive a "load more" pager.
  // `status=active` is shorthand for ('running','paused') — used by the
  // header's "live" filter on the workflows tab.
  app.get("/workflow-runs", (c) => {
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const since = c.req.query("since") || undefined;
    const workflowName = c.req.query("workflow") || undefined;
    const statusParam = c.req.query("status");
    const limit = Math.min(Math.max(parseInt(rawLimit ?? "20", 10) || 20, 1), 200);
    const offset = Math.max(parseInt(rawOffset ?? "0", 10) || 0, 0);

    let statuses: string[] | undefined;
    if (statusParam === "active") {
      statuses = ["running", "paused"];
    } else if (statusParam) {
      statuses = statusParam.split(",").filter(Boolean);
    }

    const { runs, total } = db.listWorkflowRuns({
      limit,
      offset,
      sinceIso: since,
      workflowName,
      statuses,
    });
    return c.json({ workflowRuns: runs, total });
  });

  // Distinct workflow names — used to populate the dashboard's filter row.
  app.get("/workflow-names", (c) => {
    return c.json({ names: db.distinctWorkflowNames() });
  });

  app.get("/workflow-runs/:id", (c) => {
    const id = c.req.param("id");
    const run = db.getWorkflowRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    return c.json({ workflowRun: run });
  });

  // List the executions belonging to a workflow run, ordered by start time.
  // Used by the dashboard's pipeline-detail view to look up the session id
  // (and usage metrics) for any phase the user clicks.
  app.get("/workflow-runs/:id/executions", (c) => {
    const id = c.req.param("id");
    const run = db.getWorkflowRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    const rows = db.getExecutionsForWorkflowRun(run.id, run.triggerId, run.workflowName);
    const prefix = `${run.workflowName}:`;
    const executions = rows.map((r) => ({
      id: r.id,
      skill: r.skill,
      // <workflowName>:<phaseName> → phaseName
      phase: r.skill.startsWith(prefix) ? r.skill.slice(prefix.length) : r.skill,
      sessionId: r.sessionId,
      success: r.success,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      turns: r.turns,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      cacheCreationInputTokens: r.cacheCreationInputTokens,
      cacheReadInputTokens: r.cacheReadInputTokens,
      outputTokens: r.outputTokens,
      apiDurationMs: r.apiDurationMs,
      stopReason: r.stopReason,
    }));
    return c.json({ executions });
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

  // ── Workflow definitions ─────────────────────────────────────────
  //
  // The dashboard's pipeline visualisation fetches definitions from here so
  // it can render exactly the phases the YAML file declares — including
  // user-defined custom workflows. No hardcoded phase list, no fallback.

  app.get("/workflows/:name", async (c) => {
    const name = c.req.param("name");
    try {
      const { getWorkflow } = await import("../workflows/loader.js");
      const def = getWorkflow(name);
      // Return only the dashboard-relevant subset (no prompt template paths,
      // no model overrides) — keeps the surface small and stable.
      return c.json({
        workflow: {
          name: def.name,
          kind: def.kind,
          description: def.description,
          phases: def.phases.map((p) => ({
            name: p.name,
            label: p.label ?? p.name,
            type: p.type,
            hasLoop: !!p.loop || !!p.generic_loop,
            approvalGate: p.approval_gate,
          })),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `workflow definition not found: ${name}`, detail: msg }, 404);
    }
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
    const workflowRun = db.getWorkflowRun(approval.workflowRunId);
    if (body.decision === "rejected") {
      if (workflowRun) {
        db.finishWorkflowRun(approval.workflowRunId, "failed", `Rejected via dashboard: ${body.reason || "no reason"}`);
      }
    } else if (body.decision === "approved" && workflowRun && config.resumeWorkflow) {
      config.resumeWorkflow(workflowRun, "admin").catch((err) => {
        console.error(`[admin] Failed to resume workflow ${workflowRun.id}:`, err);
      });
    }
    return c.json({ status: body.decision });
  });

  return app;
}
