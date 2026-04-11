import { randomUUID } from "crypto";
import type { ExecutorConfig } from "../engine/executor.js";
import type { StateDb } from "../state/db.js";
import type { ModelConfig } from "../config.js";
import { getWorkflow } from "./loader.js";
import { runWorkflow, type RunnerCallbacks, type WorkflowResult } from "./runner.js";
import type { TemplateContext } from "./templates.js";
import { slugify } from "./templates.js";
import { BOOTSTRAP_LABEL } from "../engine/orchestrator.js";

/**
 * Lightweight invocation request for any agent workflow — used by anything
 * that isn't the full multi-phase build cycle. The build cycle has its own
 * runBuildCycle wrapper because it needs the resume / approval gate logic;
 * everything else (issue triage, PR review, repo health, single-issue
 * comments, custom user workflows) goes through this.
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
   * workflow-specific args like { mode: "scan" } from cron jobs.
   */
  extra?: Record<string, unknown>;
}

/**
 * Run a named agent workflow against a target.
 *
 * Creates a row in the workflow_runs table so the run shows up in the
 * dashboard's workflow flow view alongside the build cycle. Even
 * single-phase workflows (issue-triage, pr-review, etc.) become first-class
 * tracked runs.
 *
 * Caller is responsible for any post-completion notification logic — this
 * function just runs the workflow and updates the DB row.
 */
export async function runSimpleWorkflow(
  workflowName: string,
  request: SimpleWorkflowRequest,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db: StateDb,
  models?: ModelConfig,
): Promise<WorkflowResult> {
  const definition = getWorkflow(workflowName);
  const { owner, repo, issueNumber, prNumber } = request;

  // Identify the trigger uniquely. Issue/PR-scoped workflows include the
  // number; repo-scoped workflows (e.g. health) just identify by repo+name.
  const number = issueNumber ?? prNumber;
  const triggerId = number !== undefined
    ? `${owner}/${repo}#${number}`
    : `${owner}/${repo}::${workflowName}`;

  // Per-task ID — used for sandbox container naming and as a stable handle
  // across resume attempts. Must be unique enough to avoid collisions.
  const taskId = number !== undefined
    ? `${repo}-${number}-${workflowName}`
    : `${repo}-${workflowName}-${randomUUID().slice(0, 8)}`;

  // Branch is informational for non-build workflows but build prompts use it.
  // Use the same naming scheme the build cycle uses so reads are consistent.
  const branch = number !== undefined
    ? `lastlight/${number}-${slugify(request.issueTitle || `issue-${number}`)}`
    : `lastlight/${workflowName}`;

  const issueDir = number !== undefined
    ? `.lastlight/issue-${number}`
    : `.lastlight/${workflowName}`;

  // Create the workflow_run row up-front so the dashboard sees it
  // immediately, even before the agent starts. The runner updates the
  // current_phase as phases progress.
  //
  // The dashboard fetches the workflow definition by name from
  // /admin/api/workflows/<workflowName> so it can render the actual phases
  // — no phase list duplication here.
  const workflowId = randomUUID();
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
    bootstrapLabel: BOOTSTRAP_LABEL,
    contextSnapshot: "",
    models: models as unknown as Record<string, unknown>,
    // Extra workflow-specific args (e.g. mode: scan from cron)
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
      undefined,        // approvalConfig — only build cycle uses this for now
      workflowId,
      undefined,        // startFrom — simple workflows don't have a resume path
    );

    // Mark the run finished. Build cycle has its own finish logic; for simple
    // workflows we trust the runner's success bool.
    if (result.success) {
      db.finishWorkflowRun(workflowId, "succeeded");
    } else if (!result.paused) {
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
