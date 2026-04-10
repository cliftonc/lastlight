import type { ExecutorConfig } from "./executor.js";
import { executeAgent } from "./executor.js";
import type { StateDb } from "../state/db.js";
import type { ModelConfig } from "../config.js";
import { resolveModel } from "../config.js";
import { randomUUID } from "crypto";
import { getWorkflow, loadPromptTemplate } from "../workflows/loader.js";
import { renderTemplate, slugify, type TemplateContext } from "../workflows/templates.js";
import {
  runWorkflow,
  isTerminated,
  type ApprovalGateConfig,
  type RunnerCallbacks,
} from "../workflows/runner.js";

/**
 * Configuration for approval gates in the build cycle.
 * When a gate is enabled, the orchestrator pauses and posts a notification
 * asking a maintainer to approve or reject before proceeding.
 */
export type { ApprovalGateConfig };

/**
 * Build request context.
 */
export interface BuildRequest {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** Labels currently on the issue — used to detect bootstrap tasks. */
  issueLabels?: string[];
  commentBody?: string;
  sender: string;
}

/** Label applied to issues that exist solely to set up missing guardrails. */
export const BOOTSTRAP_LABEL = "lastlight:bootstrap";

/**
 * Run the full Architect → Executor → Reviewer build cycle for an issue.
 * Loads the build.yaml workflow definition and delegates to the generic runner.
 */
export async function runBuildCycle(
  request: BuildRequest,
  config: ExecutorConfig,
  callbacks?: {
    onPhaseStart?: (phase: string) => Promise<void>;
    onPhaseEnd?: (
      phase: string,
      result: { phase: string; success: boolean; output: string; error?: string },
    ) => Promise<void>;
    postComment?: (body: string) => Promise<void>;
  },
  db?: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
): Promise<{ success: boolean; phases: { phase: string; success: boolean; output: string; error?: string }[]; prNumber?: number; paused?: boolean }> {
  const { owner, repo, issueNumber } = request;
  const branch = `lastlight/${issueNumber}-${slugify(request.issueTitle)}`;
  const taskId = `${repo}-${issueNumber}`;
  const issueDir = `.lastlight/issue-${issueNumber}`;
  const triggerId = `${owner}/${repo}#${issueNumber}`;

  const notify = callbacks?.postComment || (async () => {});

  console.log(`[orchestrator] Build cycle for ${owner}/${repo}#${issueNumber}`);
  await notify(
    `Acknowledged — starting build cycle for #${issueNumber}. Checking for prior progress...`,
  );

  // ── Resume logic (DB-driven) ─────────────────────────────────────────────

  let workflowId: string;
  const PHASE_ORDER = ["phase_0", "guardrails", "architect", "executor", "reviewer", "complete"] as const;
  type Phase = (typeof PHASE_ORDER)[number];

  function phaseIndex(phase: string): number {
    if (phase.startsWith("fix_loop")) return PHASE_ORDER.indexOf("executor");
    const idx = PHASE_ORDER.indexOf(phase as Phase);
    return idx === -1 ? -1 : idx;
  }

  if (db) {
    const existingRun = db.getWorkflowRunByTrigger(triggerId);

    if (existingRun) {
      workflowId = existingRun.id;
      const completedPhase = existingRun.currentPhase;

      if (completedPhase === "complete") {
        await notify(
          `Build cycle for #${issueNumber} is already complete. See the existing PR on branch \`${branch}\`.`,
        );
        return {
          success: true,
          phases: [{ phase: "resume", success: true, output: "Already complete" }],
        };
      }

      // Handle paused workflow waiting for approval
      if (existingRun.status === "paused" && completedPhase === "waiting_approval") {
        const pendingApproval = db.getPendingApprovalForWorkflow(workflowId);
        if (pendingApproval?.status === "approved") {
          const gate = pendingApproval.gate;
          const resumeFrom = gate === "post_architect" ? "executor" : "reviewer";
          console.log(
            `[orchestrator] Approval received for gate ${gate} — resuming from ${resumeFrom}`,
          );
          db.resumeWorkflowRun(workflowId);
          await notify(
            `**Approval received** — resuming build cycle from **${resumeFrom}** phase.`,
          );
        } else if (pendingApproval?.status === "rejected") {
          const reason = pendingApproval.response || "no reason given";
          db.finishWorkflowRun(workflowId, "failed", `Rejected: ${reason}`);
          await notify(`Build cycle for #${issueNumber} was rejected. Reason: ${reason}`);
          return {
            success: false,
            phases: [{ phase: "rejected", success: false, output: `Rejected: ${reason}` }],
          };
        } else {
          await notify(`Build cycle for #${issueNumber} is paused, awaiting approval.`);
          return { success: true, phases: [], paused: true };
        }
      } else {
        const completedIdx = phaseIndex(completedPhase);
        if (completedIdx >= 0 && completedIdx < PHASE_ORDER.length - 1) {
          const resumeFrom = PHASE_ORDER[completedIdx + 1];
          console.log(
            `[orchestrator] Resuming from ${resumeFrom} (last completed: ${completedPhase}) — DB run ${workflowId}`,
          );
          await notify(
            `**Resuming build cycle** for #${issueNumber} from **${resumeFrom}** phase.\n` +
              `Previous progress found on branch \`${branch}\` (last completed: \`${completedPhase}\`).`,
          );
        }
      }
    } else {
      workflowId = randomUUID();
      db.createWorkflowRun({
        id: workflowId,
        workflowName: "build",
        triggerId,
        repo,
        issueNumber,
        currentPhase: "phase_0",
        status: "running",
        context: { branch, taskId, models: models as Record<string, unknown> | undefined },
        startedAt: new Date().toISOString(),
      });
      console.log(`[orchestrator] Created workflow run ${workflowId}`);
    }
  } else {
    // No DB — fall back to agent-based resume check
    workflowId = randomUUID();
    const resumeTemplate = loadPromptTemplate("prompts/resume-check.md");
    const resumePrompt = renderTemplate(resumeTemplate, {
      owner, repo, issueNumber, issueTitle: request.issueTitle,
      issueBody: request.issueBody, issueLabels: request.issueLabels || [],
      commentBody: request.commentBody || "", sender: request.sender,
      branch, taskId, issueDir, bootstrapLabel: BOOTSTRAP_LABEL,
    });
    const resumeResult = await executeAgent(resumePrompt, config, {
      taskId: `${taskId}-resume-check`,
    });

    if (resumeResult.success && resumeResult.output) {
      const output = resumeResult.output;
      if (output.includes("current_phase: complete")) {
        await notify(
          `Build cycle for #${issueNumber} is already complete. See the existing PR on branch \`${branch}\`.`,
        );
        return {
          success: true,
          phases: [{ phase: "resume", success: true, output: "Already complete" }],
        };
      }
    }
  }

  // ── Build template context ───────────────────────────────────────────────

  const contextSnapshot = `
Task: ${request.commentBody || request.issueBody}
Issue: ${owner}/${repo}#${issueNumber} — ${request.issueTitle}
Issue body: ${request.issueBody}
Requested by: ${request.sender}
Branch: ${branch}
`.trim();

  const ctx: TemplateContext = {
    owner,
    repo,
    issueNumber,
    issueTitle: request.issueTitle,
    issueBody: request.issueBody,
    issueLabels: request.issueLabels || [],
    commentBody: request.commentBody || "",
    sender: request.sender,
    branch,
    taskId,
    issueDir,
    bootstrapLabel: BOOTSTRAP_LABEL,
    contextSnapshot,
    // models object for template interpolation (e.g. {{models.architect}})
    models: models as unknown as Record<string, unknown>,
  };

  // ── Load and run the workflow ─────────────────────────────────────────────

  const definition = getWorkflow("build");

  const runnerCallbacks: RunnerCallbacks = {
    onPhaseStart: callbacks?.onPhaseStart,
    onPhaseEnd: callbacks?.onPhaseEnd,
    postComment: callbacks?.postComment,
  };

  return runWorkflow(definition, ctx, config, runnerCallbacks, db, models, approvalConfig, workflowId);
}

// ── PR Fix ────────────────────────────────────────────────────────────────────

export interface PrFixRequest {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  commentBody: string;
  sender: string;
  branch: string;
  /** CI check failures from GitHub Actions, pre-fetched by the harness */
  failedChecks?: string;
}

/**
 * Lightweight PR fix — no architect/reviewer, just fix and push.
 * Used when a maintainer comments on a PR asking the bot to fix something.
 */
export async function runPrFix(
  request: PrFixRequest,
  config: ExecutorConfig,
  callbacks?: {
    postComment?: (body: string) => Promise<void>;
  },
  models?: ModelConfig,
): Promise<{ success: boolean; output: string }> {
  const notify = callbacks?.postComment || (async () => {});
  const { owner, repo, prNumber, branch } = request;
  const taskId = `${repo}-pr${prNumber}-fix`;

  const prFixModel = models ? resolveModel(models, "pr-fix") : undefined;
  const prFixConfig = prFixModel ? { ...config, model: prFixModel } : config;

  await notify(`On it — fixing PR #${prNumber}...`);

  // Build the CI section
  const ciSection =
    request.failedChecks && !request.failedChecks.includes("No failed checks")
      ? `CI FAILURES (from GitHub Actions — fix these first):\n${request.failedChecks}`
      : "";

  const issueDir = `.lastlight/pr-${prNumber}`;
  const ctx: TemplateContext = {
    owner,
    repo,
    issueNumber: prNumber,
    issueTitle: request.prTitle,
    issueBody: request.prBody,
    issueLabels: [],
    commentBody: request.commentBody,
    sender: request.sender,
    branch,
    taskId,
    issueDir,
    bootstrapLabel: BOOTSTRAP_LABEL,
    prNumber,
    prTitle: request.prTitle,
    prBody: request.prBody,
    failedChecks: request.failedChecks,
    ciSection,
  };

  const template = loadPromptTemplate("prompts/pr-fix.md");
  const prompt = renderTemplate(template, ctx);

  const result = await executeAgent(prompt, prFixConfig, { taskId });

  if (result.success) {
    await notify(`**Fix pushed** to \`${branch}\`. CI should re-run automatically.`);
  } else if (isTerminated(result.error)) {
    console.log(`[pr-fix] Session terminated — suppressing error comment`);
  } else {
    await notify(`**Fix failed** — I wasn't able to resolve this automatically.`);
  }

  return { success: result.success, output: result.output };
}
