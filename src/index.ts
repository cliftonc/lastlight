import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { loadConfig, generateMcpConfig, resolveModel } from "./config.js";
import { ConnectorRegistry, GitHubWebhookConnector, SlackConnector, SessionManager, MessageDeliveryService } from "./connectors/index.js";
import { routeEvent } from "./engine/router.js";
import { handleChatMessage } from "./engine/chat.js";
import { configureGitAuth } from "./engine/git-auth.js";
import { StateDb } from "./state/db.js";
import { CronScheduler } from "./cron/scheduler.js";
import { getJobs } from "./cron/jobs.js";
import { mountAdmin } from "./admin/index.js";
import { cleanupOrphanedSandboxes } from "./sandbox/index.js";
import { authMiddleware } from "./admin/auth.js";
import { GitHubClient } from "./engine/github.js";
import { runSimpleWorkflow, type SimpleWorkflowRequest } from "./workflows/simple.js";
import type { RunnerCallbacks } from "./workflows/runner.js";
import { resumeOrphanedWorkflows } from "./workflows/resume.js";
import type { EventEnvelope } from "./connectors/types.js";

async function main() {
  console.log("Last Light v2.0 — Agent SDK Harness");
  console.log("====================================");

  // Load config
  const config = loadConfig();
  console.log(`[config] Port: ${config.port}, Model: ${config.model}`);
  const modelOverrides = Object.entries(config.models).filter(([k]) => k !== "default");
  if (modelOverrides.length > 0) {
    console.log(`[config] Model overrides: ${modelOverrides.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

  // Clean up any sandbox containers left over from a previous run
  cleanupOrphanedSandboxes();

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
  // Non-fatal: if this fails (e.g., DNS not ready yet), the app still starts.
  // Git auth is refreshed before each agent execution anyway.
  if (config.githubApp) {
    try {
      await configureGitAuth({
        appId: config.githubApp.appId,
        privateKeyPath: config.githubApp.privateKeyPath,
        installationId: config.githubApp.installationId,
      });
    } catch (err: any) {
      console.warn(`[git-auth] Initial git auth failed (will retry per-execution): ${err.message}`);
    }
  }

  // Initialize state database
  const db = new StateDb(config.dbPath);
  console.log(`[state] Database: ${config.dbPath}`);

  // GitHub API client for harness-level operations (posting comments, fetching issues)
  const github = config.githubApp ? new GitHubClient(config.githubApp) : null;

  /**
   * Dispatch a workflow by name. Used by webhook events, cron jobs, and the
   * /api/run endpoint. Every dispatch creates a workflow_run row visible in
   * the dashboard, regardless of whether it's a single-phase workflow (like
   * issue-triage) or a multi-phase one.
   *
   * The router still uses skill names for backwards compat — for the four
   * agent skills they're 1:1 with workflow names.
   */
  const dispatchWorkflow = async (
    workflowName: string,
    context: Record<string, unknown>,
  ): Promise<{ success: boolean; error?: string }> => {
    const repoStr = context.repo as string | undefined;
    if (!repoStr) {
      const msg = `dispatchWorkflow(${workflowName}): missing 'repo' in context`;
      console.error(`[dispatch] ${msg}`);
      return { success: false, error: msg };
    }
    const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
    if (!owner || !repo) {
      const msg = `dispatchWorkflow(${workflowName}): invalid repo format '${repoStr}'`;
      console.error(`[dispatch] ${msg}`);
      return { success: false, error: msg };
    }

    // Pluck the standard fields, leave the rest in `extra` for the workflow
    // template to consume.
    const {
      _triggerType,
      repo: _r,
      issueNumber,
      prNumber,
      title,
      body,
      labels,
      sender,
      commentBody,
      ...rest
    } = context;

    const request: SimpleWorkflowRequest = {
      owner,
      repo,
      issueNumber: typeof issueNumber === "number" ? issueNumber : undefined,
      prNumber: typeof prNumber === "number" ? prNumber : undefined,
      issueTitle: typeof title === "string" ? title : "",
      issueBody: typeof body === "string" ? body : "",
      issueLabels: Array.isArray(labels) ? (labels as string[]) : undefined,
      commentBody: typeof commentBody === "string" ? commentBody : undefined,
      sender: typeof sender === "string" ? sender : "unknown",
      extra: rest as Record<string, unknown>,
    };

    const callbacks: RunnerCallbacks = {
      postComment: github && issueNumber
        ? async (msg) => {
            try {
              await github.postComment(owner, repo, issueNumber as number, msg);
            } catch (err: unknown) {
              const m = err instanceof Error ? err.message : String(err);
              console.warn(`[dispatch] Failed to post comment: ${m}`);
            }
          }
        : undefined,
      onPhaseStart: async (phase) => console.log(`[dispatch] ▶ ${workflowName}/${phase}`),
      onPhaseEnd: async (phase, result) =>
        console.log(`[dispatch] ◀ ${workflowName}/${phase}: ${result.success ? "OK" : "FAILED"}`),
    };

    try {
      const result = await runSimpleWorkflow(
        workflowName,
        request,
        {
          mcpConfigPath,
          model: config.model,
          maxTurns: config.maxTurns,
          stateDir: config.stateDir,
          sandboxDir: config.sandboxDir,
        },
        callbacks,
        db,
        config.models,
        config.approval,
        config.bootstrapLabel,
      );
      const summary = result.phases.map((p) => `${p.phase}=${p.success ? "ok" : "fail"}`).join(", ");
      if (result.success) {
        console.log(`[dispatch] ${workflowName} completed (${summary})`);
      } else {
        console.warn(`[dispatch] ${workflowName} failed (${summary})`);
      }
      return { success: result.success };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch] ${workflowName} threw: ${msg}`);
      return { success: false, error: msg };
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
      slackOAuthClientId: process.env.SLACK_OAUTH_CLIENT_ID,
      slackOAuthClientSecret: process.env.SLACK_OAUTH_CLIENT_SECRET,
      slackOAuthRedirectUri: process.env.SLACK_OAUTH_REDIRECT_URI,
      slackAllowedWorkspace: process.env.SLACK_ALLOWED_WORKSPACE,
      adminNotifier: slackConnector
        ? (msg: string) => slackConnector!.sendToDeliveryChannel(msg)
        : undefined,
      resumeWorkflow: async (workflowRun, sender) => {
        if (!github) {
          console.warn(`[admin] Cannot resume workflow ${workflowRun.id}: GitHub App not configured`);
          return;
        }
        const [owner, repo] = workflowRun.triggerId.includes("/")
          ? workflowRun.triggerId.replace(/#\d+$/, "").split("/")
          : ["", ""];
        const issueNumber = workflowRun.issueNumber;
        if (!owner || !repo || !issueNumber) {
          console.warn(`[admin] Cannot resume workflow ${workflowRun.id}: missing owner/repo/issueNumber`);
          return;
        }
        db.resumeWorkflowRun(workflowRun.id);
        console.log(`[admin] Resuming ${workflowRun.workflowName} for ${owner}/${repo}#${issueNumber} after dashboard approval by ${sender}`);
        dispatchWorkflow(workflowRun.workflowName, {
          repo: `${owner}/${repo}`,
          issueNumber,
          title: `Issue #${issueNumber}`,
          body: "",
          sender,
          _triggerType: "admin",
        }).catch((err) => console.error(`[admin] Resume failed:`, err));
      },
    });
    console.log(`[admin] Dashboard mounted at /admin`);
  }

  // API endpoints (require HTTP server from GitHub connector)
  if (!githubConnector) {
    console.log(`[api] No HTTP server — API endpoints disabled (Slack Socket Mode only)`);
  }

  // Protect API endpoints with auth when ADMIN_PASSWORD is set
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  const adminSecret = process.env.ADMIN_SECRET ?? "lastlight-dev-secret";
  if (githubConnector && adminPassword) {
    githubConnector.honoApp.use("/api/*", authMiddleware(adminPassword, adminSecret));
    console.log(`[api] API endpoints protected with auth`);
  }

  // API endpoint for CLI triggers
  githubConnector?.honoApp.post("/api/run", async (c) => {
    const body = await c.req.json();
    // Accept either `skill` (legacy) or `workflow` (preferred). They map 1:1
    // for the four agent skills (issue-triage, pr-review, repo-health,
    // issue-comment) which are now backed by single-phase YAML workflows.
    const workflowName = (body.workflow ?? body.skill) as string | undefined;
    const context = (body.context ?? {}) as Record<string, unknown>;

    if (!workflowName) {
      return c.json({ error: "Missing 'workflow' (or 'skill') field" }, 400);
    }

    console.log(`[api] CLI triggered: workflow=${workflowName}`);

    // Run asynchronously — return immediately with a stable id the caller
    // can correlate with workflow_runs in the dashboard.
    const executionId = randomUUID();
    dispatchWorkflow(workflowName, { ...context, _triggerType: "api" }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[api] workflow ${workflowName} failed: ${msg}`);
    });

    return c.json({ accepted: true, executionId, workflow: workflowName }, 202);
  });

  // API endpoint for build cycle triggers (issue URL)
  githubConnector?.honoApp.post("/api/build", async (c) => {
    const body = await c.req.json();
    const { owner, repo, issueNumber, issueTitle, issueBody, issueLabels, sender } = body;

    if (!owner || !repo || !issueNumber) {
      return c.json({ error: "Missing owner, repo, or issueNumber" }, 400);
    }

    console.log(`[api] CLI build triggered: ${owner}/${repo}#${issueNumber}`);

    // If labels weren't supplied, fetch them so the orchestrator can detect
    // bootstrap tasks (lastlight:bootstrap label) and skip the BLOCKED gate.
    let resolvedLabels: string[] | undefined = issueLabels;
    if (!resolvedLabels && github) {
      try {
        const issue = await github.getIssue(owner, repo, issueNumber);
        resolvedLabels = (issue.labels || []).map((l: any) =>
          typeof l === "string" ? l : l.name,
        ).filter(Boolean);
      } catch { /* non-fatal */ }
    }

    // Run build cycle asynchronously via the generic dispatcher
    dispatchWorkflow("build", {
      repo: `${owner}/${repo}`,
      issueNumber,
      title: issueTitle || `Issue #${issueNumber}`,
      body: issueBody || "",
      labels: resolvedLabels,
      sender: sender || "cli",
      _triggerType: "api",
    }).catch((err) => {
      console.error(`[api] Build failed:`, err);
    });

    return c.json({ accepted: true, owner, repo, issueNumber }, 202);
  });

  // Handle events from any connector
  registry.onEvent(async (envelope: EventEnvelope) => {
    console.log(`[event] ${envelope.source}:${envelope.type} from ${envelope.sender}${envelope.repo ? ` on ${envelope.repo}` : ""}`);

    const route = await routeEvent(envelope);

    if (route.action === "ignore") {
      console.log(`[event] Ignored: ${route.reason}`);
      return;
    }

    if (route.action === "reply") {
      await envelope.reply(route.message);
      return;
    }

    const { skill, context } = route;

    // Chat messages: handle directly (no sandbox, low latency)
    if (skill === "chat") {
      const messagingSessionId = context.sessionId as string;
      const message = context.message as string;
      const sender = context.sender as string;

      // Look up the existing Agent SDK session id for this Slack thread.
      // First message has none → fresh session; subsequent messages resume.
      const messagingSession = sessionManager.getSession(messagingSessionId);
      const resumeAgentSessionId = messagingSession?.agentSessionId ?? undefined;

      // Record an executions row so chat usage shows up in dashboard stats
      // alongside sandbox runs. triggerId is the messaging-session id, so a
      // whole Slack thread groups together with `GROUP BY trigger_id`.
      const executionId = randomUUID();
      db.recordStart({
        id: executionId,
        triggerType: "chat",
        triggerId: messagingSessionId,
        skill: "chat",
        startedAt: new Date().toISOString(),
      });

      try {
        const result = await handleChatMessage(
          message,
          messagingSessionId,
          sender,
          sessionManager,
          {
            mcpConfigPath,
            model: resolveModel(config.models, "chat"),
            maxTurns: 10,
          },
          resumeAgentSessionId,
        );

        // Persist the Agent SDK session id on the first turn so the next
        // turn in this thread can resume into the same jsonl. We always
        // overwrite — if the SDK rotated the id (e.g. resume failed and it
        // started a fresh session) we want the latest one.
        if (result.agentSessionId && result.agentSessionId !== resumeAgentSessionId) {
          sessionManager.setAgentSessionId(messagingSessionId, result.agentSessionId);
        }

        db.recordFinish(executionId, {
          success: result.success,
          error: result.error,
          turns: result.turns,
          durationMs: result.durationMs,
          sessionId: result.agentSessionId,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          outputTokens: result.outputTokens,
          apiDurationMs: result.apiDurationMs,
          stopReason: result.stopReason,
        });

        await envelope.reply(result.text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[event] Chat error:`, msg);
        db.recordFinish(executionId, {
          success: false,
          error: msg,
          durationMs: 0,
        });
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

    // PR fix: lightweight fix-and-push, no full build cycle
    if (skill === "pr-fix" && context.prNumber && context.repo) {
      const repoStr = context.repo as string;
      const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
      const prNumber = context.prNumber as number;

      if (!owner || !repo) {
        console.error(`[event] Invalid repo format: ${repoStr}`);
        return;
      }

      // Fetch PR details and CI failures
      let prTitle = (context.title as string) || "";
      let prBody = (context.body as string) || "";
      let branch = "";
      let failedChecks = "";
      if (github) {
        try {
          const pr = await github.getPullRequest(owner, repo, prNumber);
          prTitle = prTitle || pr.title;
          prBody = prBody || pr.body || "";
          branch = pr.head.ref;
          // Fetch CI failures for the PR's head commit
          failedChecks = await github.getFailedChecks(owner, repo, pr.head.sha);
        } catch (err: any) {
          console.warn(`[event] Could not fetch PR: ${err.message}`);
        }
      }

      if (!branch) {
        console.error(`[event] Could not determine branch for PR #${prNumber}`);
        return;
      }

      console.log(`[event] PR fix for ${repoStr}#${prNumber} on branch ${branch}`);

      const ciSection = failedChecks && !failedChecks.includes("No failed checks")
        ? `CI FAILURES (from GitHub Actions — fix these first):\n${failedChecks}`
        : "";

      dispatchWorkflow("pr-fix", {
        repo: repoStr,
        prNumber,
        title: prTitle,
        body: prBody,
        commentBody: (context.commentBody as string) || "",
        sender: (context.sender as string) || "unknown",
        branch,
        failedChecks,
        ciSection,
        _triggerType: "webhook",
      }).catch((err) => {
        console.error(`[event] PR fix failed:`, err);
      });

      return;
    }

    // Approval responses
    if (skill === "approval-response") {
      const decision = context.decision as "approved" | "rejected";
      const sender = (context.sender as string) || "unknown";
      const reason = context.reason as string | undefined;
      const triggerId = context.repo && context.issueNumber
        ? `${context.repo}#${context.issueNumber}`
        : undefined;

      const approval = context.workflowRunId
        ? db.getPendingApprovalForWorkflow(context.workflowRunId as string)
        : triggerId
        ? db.getPendingApprovalByTrigger(triggerId)
        : null;

      if (!approval) {
        await envelope.reply("No pending approval found.");
        return;
      }

      db.respondToApproval(approval.id, decision, sender, reason);

      if (decision === "approved") {
        // Re-trigger the build cycle — resume logic in orchestrator will pick up from DB state
        const workflowRun = db.getWorkflowRun(approval.workflowRunId);
        if (workflowRun && !github) {
          await envelope.reply("Approval recorded, but cannot resume: GitHub App is not configured. Configure GITHUB_APP_ID and related env vars to enable build resumption.");
          return;
        }
        if (workflowRun && github) {
          await envelope.reply(`Approved by ${sender}. Resuming \`${workflowRun.workflowName}\`...`);
          const [owner, repo] = workflowRun.triggerId.includes("/")
            ? workflowRun.triggerId.replace(/#\d+$/, "").split("/")
            : ["", ""];
          const issueNumber = workflowRun.issueNumber;
          if (owner && repo && issueNumber) {
            db.resumeWorkflowRun(workflowRun.id);
            dispatchWorkflow(workflowRun.workflowName, {
              repo: `${owner}/${repo}`,
              issueNumber,
              title: `Issue #${issueNumber}`,
              body: "",
              sender,
              _triggerType: "approval",
            }).catch((err) => console.error(`[approval] Resume failed:`, err));
          }
        }
      } else {
        const workflowRun = db.getWorkflowRun(approval.workflowRunId);
        if (workflowRun) {
          db.finishWorkflowRun(approval.workflowRunId, "failed", `Rejected by ${sender}: ${reason || "no reason given"}`);
        }
        await envelope.reply(`Rejected by ${sender}. Build cycle aborted.${reason ? ` Reason: ${reason}` : ""}`);
      }
      return;
    }

    // Build requests: route to the programmatic orchestrator instead of the SKILL.md
    if (skill === "github-orchestrator" && context.issueNumber && context.repo) {
      const repoStr = context.repo as string;
      const [owner, repo] = repoStr.includes("/") ? repoStr.split("/") : ["", repoStr];
      const issueNumber = context.issueNumber as number;

      if (!owner || !repo) {
        console.error(`[event] Invalid repo format: ${repoStr}`);
        return;
      }

      // Fetch full issue details if we don't have them
      let issueTitle = (context.title as string) || "";
      let issueBody = (context.body as string) || "";
      let issueLabels: string[] = (context.labels as string[]) || [];
      if (github && (!issueTitle || !issueBody || issueLabels.length === 0)) {
        try {
          const issue = await github.getIssue(owner, repo, issueNumber);
          issueTitle = issueTitle || issue.title;
          issueBody = issueBody || issue.body || "";
          if (issueLabels.length === 0) {
            issueLabels = (issue.labels || []).map((l: any) =>
              typeof l === "string" ? l : l.name,
            ).filter(Boolean);
          }
        } catch (err: any) {
          console.warn(`[event] Could not fetch issue: ${err.message}`);
        }
      }

      const executionId = randomUUID();
      db.recordStart({
        id: executionId,
        triggerType: envelope.type === "message" ? "chat" : "webhook",
        triggerId: String(issueNumber),
        skill: "build-cycle",
        repo: repoStr,
        issueNumber,
        startedAt: new Date().toISOString(),
      });

      if (envelope.type === "message") {
        await envelope.reply(`Starting build cycle for ${repoStr}#${issueNumber}...`);
      } else if (github) {
        // GitHub-triggered builds: react with 🚀 on the triggering comment so
        // the user sees an instant ack before guardrails / architect / etc.
        // start running. Non-fatal if it fails.
        const commentId = (envelope.raw as { comment?: { id?: number } } | undefined)?.comment?.id;
        if (commentId) {
          github
            .reactToComment(owner, repo, commentId, "rocket")
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[event] Could not react to trigger comment: ${msg}`);
            });
        }
      }

      dispatchWorkflow("build", {
        repo: repoStr,
        issueNumber,
        title: issueTitle || `Issue #${issueNumber}`,
        body: issueBody,
        labels: issueLabels,
        commentBody: context.commentBody as string,
        sender: (context.sender as string) || "unknown",
        _triggerType: envelope.type === "message" ? "chat" : "webhook",
      }).then((result) => {
        db.recordFinish(executionId, {
          success: result.success,
          error: result.success ? undefined : "Build cycle failed",
          durationMs: 0,
        });
        if (envelope.type === "message") {
          envelope.reply(result.success ? `Build cycle complete.` : `Build cycle failed.`);
        }
      }).catch((err) => {
        console.error(`[event] Build cycle failed:`, err);
        db.recordFinish(executionId, { success: false, error: err.message, durationMs: 0 });
      });

      return;
    }

    // For messaging-triggered skills, acknowledge and reply when done.
    // The router still uses skill names — they map 1:1 to workflow YAML names
    // for the four agent skills (issue-triage, pr-review, repo-health, issue-comment).
    if (envelope.type === "message") {
      await envelope.reply(`Starting *${skill}*... I'll report back when it's done.`);
      dispatchWorkflow(skill, { ...context, _triggerType: "chat" }).then(async (result) => {
        if (result.success) {
          await envelope.reply(`*${skill}* completed.`);
        } else {
          await envelope.reply(`*${skill}* failed${result.error ? `: ${result.error}` : ""}.`);
        }
      }).catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[event] workflow ${skill} threw: ${msg}`);
        await envelope.reply(`*${skill}* failed: ${msg}`);
      });
      return;
    }

    // Run workflow asynchronously (webhook triggers)
    dispatchWorkflow(skill, { ...context, _triggerType: "webhook" }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[event] Unhandled error in workflow ${skill}: ${msg}`);
    });
  });

  // Set up cron scheduler — each cron tick dispatches an agent workflow by name
  const cron = new CronScheduler(db, async (workflowName, context) => {
    await dispatchWorkflow(workflowName, { ...context, _triggerType: "cron" });
  });

  const webhooksEnabled = !!(config.webhookSecret && config.githubApp);
  const jobs = getJobs({ webhooksEnabled });
  for (const job of jobs) {
    cron.register(job);
  }
  if (webhooksEnabled) {
    console.log("[cron] Webhooks enabled — skipping issue/PR polling crons");
  }

  // API usage/capacity checker — runs every 30 minutes, no sandbox needed.
  // Passes a Slack notifier so the cron can alert the admin if the host
  // claude CLI auth degrades (it then halts itself until cleared).
  const { checkApiUsage } = await import("./cron/rate-limits.js");
  const adminNotifier = slackConnector
    ? (msg: string) => slackConnector!.sendToDeliveryChannel(msg)
    : undefined;
  cron.registerDirect({
    name: "check-api-usage",
    schedule: "*/30 * * * *",
    handler: () => checkApiUsage(db, adminNotifier),
  });

  // Start everything
  await registry.startAll();
  console.log("[main] All connectors started");
  console.log("[main] Cron jobs registered");

  // Boot-time recovery: any workflow_runs left in 'running' state from a
  // previous harness lifetime have already had their sandbox containers
  // killed by cleanupOrphanedSandboxes(). Mark their stale execution rows as
  // failed and re-dispatch each run so the runner can pick up after the last
  // completed phase. Skips 'paused' runs — those intentionally wait for a
  // human approval and are resumed via the dashboard / GitHub comment flow.
  resumeOrphanedWorkflows({
    db,
    github,
    config: {
      mcpConfigPath,
      model: config.model,
      maxTurns: config.maxTurns,
      stateDir: config.stateDir,
      sandboxDir: config.sandboxDir,
    },
    models: config.models,
    approvalConfig: config.approval,
    bootstrapLabel: config.bootstrapLabel,
  }).catch((err) => console.error("[main] Resume sweep failed:", err));

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
