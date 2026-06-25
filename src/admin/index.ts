import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { StateDb } from "../state/db.js";
import { SessionReader } from "./sessions.js";
import { ChatSessionReader } from "./chat-session-reader.js";
import { createAdminRoutes, imageMimeForArtifact, type AdminConfig } from "./routes.js";
import { SessionLog } from "../session-log.js";
import { BuildAssetStore } from "../state/build-assets.js";

export { type AdminConfig } from "./routes.js";

/**
 * Mount admin routes and dashboard static files onto the given Hono app.
 * This mounts directly so paths like /admin/assets/* resolve correctly.
 */
export function mountAdmin(app: Hono, db: StateDb, config: AdminConfig): void {
  const sessionLog = new SessionLog(config.sessionsDir);
  const sessions = new SessionReader(sessionLog, "sandbox");
  // Chat is DB-backed: list comes from `executions` grouped by trigger_id
  // (the Slack thread), and message reads target the single jsonl owned by
  // that thread's agent_session_id rather than scanning every file in -app.
  const chatSessions = new ChatSessionReader(db, sessionLog);
  const apiRoutes = createAdminRoutes(db, sessions, chatSessions, config);

  // PUBLIC, unauthenticated, IMAGE-ONLY artifact route — registered on the
  // PARENT app BEFORE the `/admin/api` sub-app so it never enters that sub-app's
  // `authMiddleware`. Browser-QA screenshots embedded in a GitHub comment must
  // be fetchable by GitHub's image proxy with no login. Non-image docs 404, so
  // text handoff docs (architect-plan.md, status.md, …) are NEVER exposed here —
  // they stay behind auth at `/admin/api/artifacts/*`. `BuildAssetStore`'s
  // per-segment validation blocks path traversal on every param.
  // NOTE: this makes screenshots of the served app publicly reachable by URL —
  // acceptable for public repos; revisit (visibility check / signed token)
  // before enabling for private repos.
  const publicArtifactStore = config.buildAssetsDir
    ? new BuildAssetStore(config.buildAssetsDir)
    : null;
  app.get("/admin/api/public/artifacts/:owner/:repo/:key/:doc", (c) => {
    if (!publicArtifactStore) return c.json({ error: "build-assets store not configured" }, 404);
    const { owner, repo, key, doc } = c.req.param();
    const imageMime = imageMimeForArtifact(doc);
    if (!imageMime) return c.json({ error: `not found: ${doc}` }, 404); // image-only gate
    try {
      const buf = publicArtifactStore.readBuffer({ owner, repo, issueKey: key }, doc);
      if (buf === undefined) return c.json({ error: `not found: ${doc}` }, 404);
      return new Response(new Uint8Array(buf), {
        headers: { "Content-Type": imageMime, "Cache-Control": "public, max-age=300" },
      });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // API at /admin/api/*
  app.route("/admin/api", apiRoutes);

  // Static dashboard assets at /admin/*
  app.use("/admin/*", serveStatic({ root: "dashboard/dist", rewriteRequestPath: (p) => p.replace(/^\/admin/, "") }));

  // SPA fallback — serve index.html for any /admin/* that didn't match above
  app.get("/admin/*", serveStatic({ root: "dashboard/dist", path: "index.html" }));
  app.get("/admin", serveStatic({ root: "dashboard/dist", path: "index.html" }));
}
