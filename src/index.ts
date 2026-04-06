import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { loadConfig, generateMcpConfig } from "./config.js";
import { ConnectorRegistry, GitHubWebhookConnector } from "./connectors/index.js";
import { routeEvent } from "./engine/router.js";
import { executeSkill } from "./engine/executor.js";
import { agents } from "./engine/agents.js";
import { configureGitAuth } from "./engine/git-auth.js";
import { StateDb } from "./state/db.js";
import { CronScheduler } from "./cron/scheduler.js";
import { getJobs } from "./cron/jobs.js";
import { mountAdmin } from "./admin/index.js";
import type { EventEnvelope } from "./connectors/types.js";

async function main() {
  console.log("Last Light v2.0 — Agent SDK Harness");
  console.log("====================================");

  // Load config
  const config = loadConfig();
  console.log(`[config] Port: ${config.port}, Model: ${config.model}`);

  // Ensure state directory structure exists (mountable as Docker volume)
  for (const sub of ["sessions", "logs", "sandboxes"]) {
    mkdirSync(resolve(config.stateDir, sub), { recursive: true });
  }
  console.log(`[state] State dir: ${config.stateDir}`);

  // Generate MCP config file for the Agent SDK
  const mcpConfig = generateMcpConfig(config);
  const mcpConfigPath = resolve(config.mcpConfigPath);
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  console.log(`[config] MCP config written to: ${mcpConfigPath}`);

  // Configure git with GitHub App credentials — agents can git clone/push natively
  await configureGitAuth({
    appId: config.githubApp.appId,
    privateKeyPath: config.githubApp.privateKeyPath,
    installationId: config.githubApp.installationId,
  });

  // Initialize state database
  const db = new StateDb(config.dbPath);
  console.log(`[state] Database: ${config.dbPath}`);

  // Skill runner — used by both webhook events and cron jobs
  const runSkill = async (skill: string, context: Record<string, unknown>) => {
    const executionId = randomUUID();
    const triggerId = (context.issueNumber as string) || skill;

    db.recordStart({
      id: executionId,
      triggerType: context._triggerType as "webhook" | "cron" || "webhook",
      triggerId,
      skill,
      repo: context.repo as string,
      issueNumber: context.issueNumber as number,
      startedAt: new Date().toISOString(),
    });

    const result = await executeSkill(skill, context, {
      mcpConfigPath,
      model: config.model,
      maxTurns: config.maxTurns,
      stateDir: config.stateDir,
    }, agents);

    db.recordFinish(executionId, {
      success: result.success,
      error: result.error,
      turns: result.turns,
      durationMs: result.durationMs,
    });

    if (!result.success) {
      console.error(`[runner] Skill ${skill} failed: ${result.error}`);
    } else {
      console.log(`[runner] Skill ${skill} completed in ${result.turns} turns (${result.durationMs}ms)`);
    }
  };

  // Set up connector registry
  const registry = new ConnectorRegistry();

  // GitHub webhook connector
  const githubConnector = new GitHubWebhookConnector({
    port: config.port,
    webhookSecret: config.webhookSecret,
    botLogin: config.botLogin,
  });
  registry.register(githubConnector);

  // Mount admin dashboard
  mountAdmin(githubConnector.honoApp, db, {
    stateDir: config.stateDir,
    sessionsDir: resolve(process.env.CLAUDE_HOME_DIR || "./data/claude-home"),
    adminPassword: process.env.ADMIN_PASSWORD ?? "",
    adminSecret: process.env.ADMIN_SECRET ?? "lastlight-dev-secret",
  });
  console.log(`[admin] Dashboard mounted at /admin`);

  // API endpoint for CLI triggers
  githubConnector.honoApp.post("/api/run", async (c) => {
    const body = await c.req.json();
    const { skill, context } = body;

    if (!skill) {
      return c.json({ error: "Missing 'skill' field" }, 400);
    }

    console.log(`[api] CLI triggered: skill=${skill}`);

    // Run asynchronously — return immediately with an execution ID
    const executionId = randomUUID();
    runSkill(skill, { ...context, _triggerType: "api" }).catch((err) => {
      console.error(`[api] Skill ${skill} failed:`, err);
    });

    return c.json({ accepted: true, executionId, skill }, 202);
  });

  // API endpoint for build cycle triggers (issue URL)
  githubConnector.honoApp.post("/api/build", async (c) => {
    const body = await c.req.json();
    const { owner, repo, issueNumber, issueTitle, issueBody, sender } = body;

    if (!owner || !repo || !issueNumber) {
      return c.json({ error: "Missing owner, repo, or issueNumber" }, 400);
    }

    console.log(`[api] CLI build triggered: ${owner}/${repo}#${issueNumber}`);

    // Import and run build cycle asynchronously
    import("./engine/orchestrator.js").then(({ runBuildCycle }) => {
      runBuildCycle(
        {
          owner,
          repo,
          issueNumber,
          issueTitle: issueTitle || `Issue #${issueNumber}`,
          issueBody: issueBody || "",
          sender: sender || "cli",
        },
        {
          mcpConfigPath,
          model: config.model,
          maxTurns: config.maxTurns,
          stateDir: config.stateDir,
          sandboxDir: config.sandboxDir,
        },
        {
          postComment: async (msg) => console.log(`[build] ${msg}`),
          onPhaseStart: async (phase) => console.log(`[build] ▶ ${phase}`),
          onPhaseEnd: async (phase, result) =>
            console.log(`[build] ◀ ${phase}: ${result.success ? "OK" : "FAILED"}`),
        }
      ).catch((err) => {
        console.error(`[api] Build failed:`, err);
      });
    });

    return c.json({ accepted: true, owner, repo, issueNumber }, 202);
  });

  // Handle events from any connector
  registry.onEvent(async (envelope: EventEnvelope) => {
    console.log(`[event] ${envelope.source}:${envelope.type} from ${envelope.sender} on ${envelope.repo}`);

    const route = routeEvent(envelope);

    if (route.action === "ignore") {
      console.log(`[event] Ignored: ${route.reason}`);
      return;
    }

    const { skill, context } = route;

    // Check if already running for this trigger
    const triggerId = String(envelope.issueNumber || envelope.id);
    if (db.isRunning(skill, triggerId)) {
      console.log(`[event] Skipping: ${skill} already running for ${triggerId}`);
      return;
    }

    // Run skill asynchronously
    runSkill(skill, { ...context, _triggerType: "webhook" }).catch((err) => {
      console.error(`[event] Unhandled error in skill ${skill}:`, err);
    });
  });

  // Set up cron scheduler
  const cron = new CronScheduler(db, async (skill, context) => {
    await runSkill(skill, { ...context, _triggerType: "cron" });
  });

  const webhooksEnabled = !!config.webhookSecret;
  const jobs = getJobs({ webhooksEnabled });
  for (const job of jobs) {
    cron.register(job);
  }
  if (webhooksEnabled) {
    console.log("[cron] Webhooks enabled — skipping issue/PR polling crons");
  }

  // Start everything
  await registry.startAll();
  console.log("[main] All connectors started");
  console.log("[main] Cron jobs registered");
  console.log("[main] Ready to receive events");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[main] Shutting down...");
    cron.stopAll();
    await registry.stopAll();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[main] Fatal error:", err);
  process.exit(1);
});
