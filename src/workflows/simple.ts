import { randomUUID } from "crypto";
import type { ExecutorConfig } from "../engine/executor.js";
import type { StateDb, WorkflowRun } from "../state/db.js";
import type { ModelConfig } from "../config.js";
import { getWorkflow } from "./loader.js";
import {
  runWorkflow,
  nextPhaseAfter,
  type ApprovalGateConfig,
  type RunnerCallbacks,
  type WorkflowResult,
} from "./runner.js";
import type { TemplateContext } from "./templates.js";
import { slugify } from "./templates.js";

/**
 * Lightweight invocation request for any agent workflow. The runner handles
 * all phase-level logic generically, so this single entry point covers
 * everything from single-phase triage skills to the full multi-phase build
 * cycle — including resume, approval gates, and the paused/approved/rejected
 * dance after a human responds to an approval.
 */
export interface SimpleWorkflowRequest {
  owner: string;
  repo: string;
  /** Optional — populated for issue-scoped workflows */
  issueNumber?: number;
  /** Optional — populated for PR-scoped workflows */
  prNumber?: number;
  /** Issue title (best-effort, may be empty for repo-scoped workflows) */
  issueTitle?: string;
  /** Issue body (best-effort) */
  issueBody?: string;
  /** Labels currently on the issue/PR */
  issueLabels?: string[];
  /** The triggering comment body, if applicable */
  commentBody?: string;
  /** Originating user (or "cli" / "cron" etc.) */
  sender: string;
  /**
   * Extra context to merge into the template context. Use this for
   * workflow-specific args like { mode: "scan" } from cron jobs, or the
   * pr-fix workflow's failedChecks/branch/prNumber payload.
   */
  extra?: Record<string, unknown>;
}

/**
 * Run a named agent workflow against a target.
 *
 * If a workflow_run row already exists for this trigger, we reuse it and let
 * the runner's definition-driven resume pick up after the last completed
 * phase — including the paused/approved/rejected paths. Otherwise we create a
 * fresh row so the dashboard sees it immediately.
 */
export async function runSimpleWorkflow(
  workflowName: string,
  request: SimpleWorkflowRequest,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  bootstrapLabel = "lastlight:bootstrap",
): Promise<WorkflowResult> {
  const definition = getWorkflow(workflowName);
  const { owner, repo, issueNumber, prNumber } = request;
  const notify = callbacks.postComment || (async () => {});

  // Identify the trigger uniquely. Issue/PR-scoped workflows include the
  // number; repo-scoped workflows (e.g. health) just identify by repo+name.
  const number = issueNumber ?? prNumber;
  const triggerId = number !== undefined
    ? `${owner}/${repo}#${number}`
    : `${owner}/${repo}::${workflowName}`;

  // Per-task ID — used for sandbox container naming and as a stable handle
  // across resume attempts.
  const taskId = number !== undefined
    ? `${repo}-${number}-${workflowName}`
    : `${repo}-${workflowName}-${randomUUID().slice(0, 8)}`;

  const branch = number !== undefined
    ? `lastlight/${number}-${slugify(request.issueTitle || `issue-${number}`)}`
    : `lastlight/${workflowName}`;

  const issueDir = number !== undefined
    ? `.lastlight/issue-${number}`
    : `.lastlight/${workflowName}`;

  // ── Resume handling ────────────────────────────────────────────────────────
  //
  // If a workflow_run already exists for this trigger, reuse its id. The
  // runner's `nextPhaseAfter(definition, currentPhase)` derives the resume
  // point — no per-workflow branching needed.

  // Only reuse a workflow_run row when the existing run is still live
  // (running/paused). `getWorkflowRunByTrigger` already filters out
  // completed rows — a fresh re-trigger for a succeeded run falls through
  // to the `else` branch, creating a new workflow_run_id and a new set of
  // dedup-scoped executions.
  let workflowId: string;
  const existingRun = db.getWorkflowRunByTrigger(triggerId);
  if (existingRun && existingRun.workflowName === workflowName) {
    workflowId = existingRun.id;
    const handled = await handleExistingRun(existingRun, definition, notify, db);
    if (handled) return handled;
  } else {
    workflowId = randomUUID();
    db.createWorkflowRun({
      id: workflowId,
      workflowName,
      triggerId,
      repo,
      issueNumber: issueNumber ?? prNumber,
      currentPhase: definition.phases[0]?.name || "phase_0",
      status: "running",
      context: {
        kind: definition.kind,
        branch,
        taskId,
        models: models as Record<string, unknown> | undefined,
        ...request.extra,
      },
      startedAt: new Date().toISOString(),
    });
    console.log(`[simple] Created workflow run ${workflowId} (${workflowName})`);
  }

  // ── Build template context ─────────────────────────────────────────────────

  const contextSnapshot = request.issueBody
    ? `Task: ${request.commentBody || request.issueBody}\nIssue: ${owner}/${repo}${issueNumber ? `#${issueNumber}` : ""} — ${request.issueTitle || ""}\nRequested by: ${request.sender}\nBranch: ${branch}`
    : "";

  const ctx: TemplateContext = {
    owner,
    repo,
    issueNumber: issueNumber ?? 0,
    issueTitle: request.issueTitle || "",
    issueBody: request.issueBody || "",
    issueLabels: request.issueLabels || [],
    commentBody: request.commentBody || "",
    sender: request.sender,
    branch,
    taskId,
    issueDir,
    bootstrapLabel,
    contextSnapshot,
    models: models as unknown as Record<string, unknown>,
    // Extra workflow-specific args (e.g. mode: scan from cron, or the PR fix
    // payload). These become top-level ctx keys so prompt templates can read
    // them directly via {{failedChecks}} etc.
    ...(request.extra || {}),
  };

  try {
    const result = await runWorkflow(
      definition,
      ctx,
      config,
      callbacks,
      db,
      models,
      approvalConfig,
      workflowId,
    );

    if (result.success && !result.paused) {
      db.finishWorkflowRun(workflowId, "succeeded");
    } else if (!result.success && !result.paused) {
      db.finishWorkflowRun(
        workflowId,
        "failed",
        result.phases.find((p) => !p.success)?.error || "workflow failed",
      );
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    db.finishWorkflowRun(workflowId, "failed", msg);
    throw err;
  }
}

/**
 * Short-circuit for a workflow run that already has state. Returns a
 * WorkflowResult to return directly (already complete / rejected / still
 * paused), or `null` to continue into `runWorkflow` for normal resume.
 */
async function handleExistingRun(
  run: WorkflowRun,
  definition: ReturnType<typeof getWorkflow>,
  notify: (msg: string) => Promise<void>,
  db: StateDb,
): Promise<WorkflowResult | null> {
  // Workflow already completed (currentPhase points past the last real phase
  // — e.g. a set_phase terminal marker like "complete"). Don't re-run.
  if (run.currentPhase && nextPhaseAfter(definition, run.currentPhase) === null) {
    const exactIdx = definition.phases.findIndex((p) => p.name === run.currentPhase);
    if (exactIdx === -1) {
      await notify(`Workflow \`${run.workflowName}\` is already complete for this trigger.`);
      return {
        success: true,
        phases: [{ phase: "resume", success: true, output: "Already complete" }],
      };
    }
  }

  // Paused awaiting approval — see if a human has responded.
  if (run.status === "paused" && run.currentPhase === "waiting_approval") {
    const pendingApproval = db.getPendingApprovalForWorkflow(run.id);
    if (pendingApproval?.status === "approved") {
      // The approval gate has been cleared. Walk the definition to find which
      // phase owned the gate, then update currentPhase to that phase so the
      // runner's nextPhaseAfter() lands on the phase AFTER it.
      const owningPhase = findPhaseOwningGate(definition, pendingApproval.gate);
      if (owningPhase) {
        db.updateWorkflowPhase(run.id, owningPhase, {
          phase: owningPhase,
          timestamp: new Date().toISOString(),
          success: true,
          summary: `Resumed after gate approval: ${pendingApproval.gate}`,
        });
      }
      console.log(
        `[simple] Approval received for gate ${pendingApproval.gate} — resuming ${run.workflowName}`,
      );
      db.resumeWorkflowRun(run.id);
      await notify(`**Approval received** — resuming \`${run.workflowName}\`.`);
      return null; // fall through to runWorkflow
    } else if (pendingApproval?.status === "rejected") {
      const reason = pendingApproval.response || "no reason given";
      db.finishWorkflowRun(run.id, "failed", `Rejected: ${reason}`);
      await notify(`Workflow \`${run.workflowName}\` was rejected. Reason: ${reason}`);
      return {
        success: false,
        phases: [{ phase: "rejected", success: false, output: `Rejected: ${reason}` }],
      };
    } else {
      await notify(`Workflow \`${run.workflowName}\` is paused, awaiting approval.`);
      return { success: true, phases: [], paused: true };
    }
  }

  // Normal resume — the runner's definition-driven resume takes over.
  console.log(
    `[simple] Resuming ${run.workflowName} for ${run.triggerId} (last phase: ${run.currentPhase})`,
  );
  return null;
}

/** Walk definition.phases and return the phase that declares this gate. */
function findPhaseOwningGate(
  definition: ReturnType<typeof getWorkflow>,
  gateName: string,
): string | null {
  for (const p of definition.phases) {
    if (p.approval_gate === gateName) return p.name;
    if (p.loop?.approval_gate === gateName) return p.name;
  }
  return null;
}
