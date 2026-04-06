import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { loadConfig, generateMcpConfig } from "./config.js";
import { ConnectorRegistry, GitHubWebhookConnector, SlackConnector, SessionManager, MessageDeliveryService } from "./connectors/index.js";
import { routeEvent } from "./engine/router.js";
import { executeSkill } from "./engine/executor.js";
import { handleChatMessage } from "./engine/chat.js";
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
  if (config.githubApp) {
    await configureGitAuth({
      appId: config.githubApp.appId,
      privateKeyPath: config.githubApp.privateKeyPath,
      installationId: config.githubApp.installationId,
    });
  }

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

  // Session manager for messaging connectors (shared across Slack, Discord, etc.)
  const sessionManager = new SessionManager(db.database);

  // Message delivery service for cron output
  const delivery = new MessageDeliveryService();

  // GitHub webhook connector (optional — requires both webhook secret and GitHub App)
  let githubConnector: GitHubWebhookConnector | null = null;
  if (config.webhookSecret && config.githubApp) {
    githubConnector = new GitHubWebhookConnector({
      port: config.port,
      webhookSecret: config.webhookSecret,
      botLogin: config.botLogin,
    });
    registry.register(githubConnector);
  }

  // Slack connector (optional — only if SLACK_BOT_TOKEN is set)
  let slackConnector: SlackConnector | null = null;
  if (config.slack) {
    slackConnector = new SlackConnector(
      {
        botToken: config.slack.botToken,
        appToken: config.slack.appToken,
        allowedUsers: config.slack.allowedUsers,
        deliveryChannel: config.slack.deliveryChannel,
        botIdentifier: "", // Will be resolved from Slack API on connect
      },
      sessionManager
    );
    registry.register(slackConnector);

    // Register Slack as a delivery target for cron reports
    if (config.slack.deliveryChannel) {
      delivery.register("slack", (msg) => slackConnector!.sendToDeliveryChannel(msg));
    }
  }

  // Mount admin dashboard (needs an HTTP server — use GitHub connector or create standalone)
  if (githubConnector) {
    mountAdmin(githubConnector.honoApp, db, {
      stateDir: config.stateDir,
      sessionsDir: resolve(process.env.CLAUDE_HOME_DIR || "./data/claude-home"),
      adminPassword: process.env.ADMIN_PASSWORD ?? "",
      adminSecret: process.env.ADMIN_SECRET ?? "lastlight-dev-secret",
    });
    console.log(`[admin] Dashboard mounted at /admin`);
  }

  // API endpoints (require HTTP server from GitHub connector)
  if (!githubConnector) {
    console.log(`[api] No HTTP server — API endpoints disabled (Slack Socket Mode only)`);
  }

  // API endpoint for CLI triggers
  githubConnector?.honoApp.post("/api/run", async (c) => {
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
  githubConnector?.honoApp.post("/api/build", async (c) => {
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
    console.log(`[event] ${envelope.source}:${envelope.type} from ${envelope.sender}${envelope.repo ? ` on ${envelope.repo}` : ""}`);

    const route = routeEvent(envelope);

    if (route.action === "ignore") {
      console.log(`[event] Ignored: ${route.reason}`);
      return;
    }

    const { skill, context } = route;

    // Chat messages: handle directly (no sandbox, low latency)
    if (skill === "chat") {
      const sessionId = context.sessionId as string;
      const message = context.message as string;
      const sender = context.sender as string;

      try {
        const response = await handleChatMessage(message, sessionId, sender, sessionManager, {
          mcpConfigPath,
          model: config.model,
          maxTurns: 10,
        });
        await envelope.reply(response);
      } catch (err) {
        console.error(`[event] Chat error:`, err);
        await envelope.reply("Sorry, I encountered an error. Please try again.");
      }
      return;
    }

    // Chat reset: deactivate the session and confirm
    if (skill === "chat-reset") {
      const sessionId = context.sessionId as string;
      if (sessionId) {
        sessionManager.deactivateSession(sessionId);
      }
      await envelope.reply("Session reset. Starting fresh.");
      return;
    }

    // Status report: return running executions
    if (skill === "status-report") {
      const running = db.runningExecutions();
      if (running.length === 0) {
        await envelope.reply("No tasks currently running.");
      } else {
        const lines = running.map((r) =>
          `• *${r.skill}*${r.repo ? ` on ${r.repo}` : ""}${r.issueNumber ? ` #${r.issueNumber}` : ""} (started ${r.startedAt})`
        );
        await envelope.reply(`Running tasks:\n${lines.join("\n")}`);
      }
      return;
    }

    // Check if already running for this trigger
    const triggerId = String(envelope.issueNumber || envelope.id);
    if (db.isRunning(skill, triggerId)) {
      console.log(`[event] Skipping: ${skill} already running for ${triggerId}`);
      // Notify messaging users that the task is already in progress
      if (envelope.type === "message") {
        await envelope.reply(`That task is already running. Use /status to check progress.`);
      }
      return;
    }

    // For messaging-triggered skills, acknowledge and reply when done
    if (envelope.type === "message") {
      await envelope.reply(`Starting *${skill}*... I'll report back when it's done.`);
      const triggerType = "chat" as const;
      runSkill(skill, { ...context, _triggerType: triggerType }).then(async () => {
        await envelope.reply(`*${skill}* completed.`);
      }).catch(async (err) => {
        console.error(`[event] Skill ${skill} failed:`, err);
        await envelope.reply(`*${skill}* failed: ${err.message}`);
      });
      return;
    }

    // Run skill asynchronously (webhook triggers)
    runSkill(skill, { ...context, _triggerType: "webhook" }).catch((err) => {
      console.error(`[event] Unhandled error in skill ${skill}:`, err);
    });
  });

  // Set up cron scheduler
  const cron = new CronScheduler(db, async (skill, context) => {
    await runSkill(skill, { ...context, _triggerType: "cron" });
  });

  const webhooksEnabled = !!(config.webhookSecret && config.githubApp);
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
