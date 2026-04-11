import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { StateDb } from "../state/db.js";
import { SessionReader } from "./sessions.js";
import { ChatSessionReader } from "./chat-session-reader.js";
import { createAdminRoutes, type AdminConfig } from "./routes.js";

export { type AdminConfig } from "./routes.js";

/**
 * Mount admin routes and dashboard static files onto the given Hono app.
 * This mounts directly so paths like /admin/assets/* resolve correctly.
 */
export function mountAdmin(app: Hono, db: StateDb, config: AdminConfig): void {
  const sessions = new SessionReader(config.sessionsDir, "sandbox");
  // Chat is DB-backed: list comes from `executions` grouped by trigger_id
  // (the Slack thread), and message reads target the single jsonl owned by
  // that thread's agent_session_id rather than scanning every file in -app.
  const chatSessions = new ChatSessionReader(db, config.sessionsDir);
  const apiRoutes = createAdminRoutes(db, sessions, chatSessions, config);

  // API at /admin/api/*
  app.route("/admin/api", apiRoutes);

  // Static dashboard assets at /admin/*
  app.use("/admin/*", serveStatic({ root: "dashboard/dist", rewriteRequestPath: (p) => p.replace(/^\/admin/, "") }));

  // SPA fallback — serve index.html for any /admin/* that didn't match above
  app.get("/admin/*", serveStatic({ root: "dashboard/dist", path: "index.html" }));
  app.get("/admin", serveStatic({ root: "dashboard/dist", path: "index.html" }));
}
