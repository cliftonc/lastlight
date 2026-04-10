import { randomUUID } from "crypto";
import type { ExecutorConfig, ExecutionResult } from "../engine/executor.js";
import { executeAgent } from "../engine/executor.js";
import type { StateDb } from "../state/db.js";
import type { PhaseHistoryEntry } from "../state/db.js";
import type { ModelConfig } from "../config.js";
import { resolveModel } from "../config.js";
import { listRunningContainers } from "../admin/docker.js";
import type { BuildWorkflowDefinition } from "./schema.js";
import { loadPromptTemplate } from "./loader.js";
import { renderTemplate, type TemplateContext } from "./templates.js";

export interface ApprovalGateConfig {
  postArchitect: boolean;
  postReviewer: boolean;
}

export interface PhaseResult {
  phase: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface RunnerCallbacks {
  onPhaseStart?: (phase: string) => Promise<void>;
  onPhaseEnd?: (phase: string, result: PhaseResult) => Promise<void>;
  postComment?: (body: string) => Promise<void>;
}

export interface WorkflowResult {
  success: boolean;
  phases: PhaseResult[];
  prNumber?: number;
  paused?: boolean;
}

// ── Phase-level deduplication ────────────────────────────────────────────────

/**
 * Check if a sandbox container is actually running for a given taskId prefix.
 */
async function isContainerAlive(taskId: string): Promise<boolean> {
  try {
    const containers = await listRunningContainers();
    return containers.some((c) => c.taskId === taskId);
  } catch {
    return false;
  }
}

/**
 * Check if an error was caused by manual termination.
 */
export function isTerminated(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("terminated") ||
    lower.includes("killed") ||
    lower.includes("exit undefined") ||
    (lower.includes("container") && lower.includes("not running"))
  );
}

function pickResult(r: ExecutionResult): Pick<ExecutionResult, "success" | "output" | "error"> {
  return { success: r.success, output: r.output, error: r.error };
}

/**
 * Run a single agent phase with DB-tracked deduplication.
 */
async function runPhase(
  phaseName: string,
  taskId: string,
  triggerId: string,
  prompt: string,
  config: ExecutorConfig,
  db?: StateDb,
  modelOverride?: string,
): Promise<{ result: ExecutionResult; skipped: false } | { skipped: true; reason: "running" | "done" }> {
  if (db) {
    const status = db.shouldRunPhase(`build:${phaseName}`, triggerId);

    if (status === "running") {
      const alive = await isContainerAlive(taskId);
      if (alive) {
        console.log(`[runner] Phase ${phaseName} is already running (container alive) — skipping`);
        return { skipped: true, reason: "running" };
      }
      console.log(`[runner] Phase ${phaseName} was running but container is dead — cleaning up`);
      db.markStaleAsFailed(`build:${phaseName}`, triggerId);
    } else if (status === "done") {
      console.log(`[runner] Phase ${phaseName} already completed successfully — skipping`);
      return { skipped: true, reason: "done" };
    }

    const executionId = randomUUID();
    db.recordStart({
      id: executionId,
      triggerType: "webhook",
      triggerId,
      skill: `build:${phaseName}`,
      repo: undefined,
      issueNumber: undefined,
      startedAt: new Date().toISOString(),
    });

    const phaseConfig = modelOverride ? { ...config, model: modelOverride } : config;
    const result = await executeAgent(prompt, phaseConfig, { taskId });

    db.recordFinish(executionId, {
      success: result.success,
      error: result.error,
      turns: result.turns,
      durationMs: result.durationMs,
    });

    return { result, skipped: false };
  }

  const phaseConfig = modelOverride ? { ...config, model: modelOverride } : config;
  const result = await executeAgent(prompt, phaseConfig, { taskId });
  return { result, skipped: false };
}

// ── Resume logic ─────────────────────────────────────────────────────────────

const PHASE_ORDER = ["phase_0", "guardrails", "architect", "executor", "reviewer", "complete"] as const;
type KnownPhase = (typeof PHASE_ORDER)[number];

function phaseIndex(phase: string): number {
  if (phase.startsWith("fix_loop")) return PHASE_ORDER.indexOf("executor");
  const idx = PHASE_ORDER.indexOf(phase as KnownPhase);
  return idx === -1 ? -1 : idx;
}

// ── Main workflow runner ─────────────────────────────────────────────────────

/**
 * Run a build workflow defined by a YAML definition.
 * Interprets phases, approval gates, and the reviewer loop generically.
 */
export async function runWorkflow(
  definition: BuildWorkflowDefinition,
  ctx: TemplateContext,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db?: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  workflowId?: string,
): Promise<WorkflowResult> {
  const phases: PhaseResult[] = [];
  const { taskId, branch, issueDir } = ctx;
  const triggerId = `${ctx.owner}/${ctx.repo}#${ctx.issueNumber}`;
  const notify = callbacks.postComment || (async () => {});
  const onStart = callbacks.onPhaseStart || (async () => {});
  const onEnd = callbacks.onPhaseEnd || (async () => {});

  const modelFor = (taskType: string): string | undefined =>
    models ? resolveModel(models, taskType) : undefined;

  /** Render a prompt template with current context. */
  const renderPrompt = (promptPath: string, extraCtx?: Partial<TemplateContext>): string => {
    const template = loadPromptTemplate(promptPath);
    return renderTemplate(template, extraCtx ? { ...ctx, ...extraCtx } : ctx);
  };

  /** Persist a phase transition to the DB workflow run. */
  const persistPhase = (phase: string, summary?: string) => {
    if (db && workflowId) {
      const entry: PhaseHistoryEntry = {
        phase,
        timestamp: new Date().toISOString(),
        success: true,
        summary,
      };
      db.updateWorkflowPhase(workflowId, phase, entry);
    }
  };

  /** Mark the workflow run as failed. */
  const failWorkflow = (errorMsg?: string) => {
    if (db && workflowId) {
      db.finishWorkflowRun(workflowId, "failed", errorMsg);
    }
  };

  // Determine resume point from DB or status
  let resumeFrom = "phase_0";
  if (db && workflowId) {
    const run = db.getWorkflowRun(workflowId);
    if (run?.currentPhase && run.currentPhase !== "phase_0") {
      const idx = phaseIndex(run.currentPhase);
      if (idx >= 0 && idx < PHASE_ORDER.length - 1) {
        resumeFrom = PHASE_ORDER[idx + 1];
      }
    }
  }

  const shouldRun = (phaseName: string): boolean => {
    const idx = phaseIndex(phaseName);
    // Unknown phases (not in PHASE_ORDER) always run — they're not tracked in resume order
    if (idx === -1) return true;
    return idx >= phaseIndex(resumeFrom);
  };

  // ── Execute phases ────────────────────────────────────────────────────────

  for (const phase of definition.phases) {
    const { name: phaseName, type: phaseType = "agent" } = phase;

    // ── Context-only phase (no agent execution) ───────────────────────────
    if (phaseType === "context") {
      if (shouldRun(phaseName)) {
        await onStart(phaseName);
        phases.push({ phase: phaseName, success: true, output: "Context assembled" });
        await onEnd(phaseName, phases[phases.length - 1]);
      }
      continue;
    }

    // ── Agent phase ───────────────────────────────────────────────────────
    if (!phase.prompt) {
      console.warn(`[runner] Phase "${phaseName}" has type=agent but no prompt — skipping`);
      continue;
    }

    // Check if this is a looping phase (e.g. reviewer)
    if (phase.loop) {
      const loop = phase.loop;
      const MAX_CYCLES = loop.max_cycles;
      let approved = false;
      let fixCycles = 0;

      if (!shouldRun(phaseName)) {
        // The phase was already completed — mark as approved and continue to next phase
        approved = true;
        phases.push({ phase: phaseName, success: true, output: "Already completed" });
      }

      while (!approved && fixCycles <= MAX_CYCLES) {
        const reviewLabel = fixCycles === 0 ? phaseName : `${phaseName}_${fixCycles + 1}`;

        if (!shouldRun(phaseName) && fixCycles === 0) {
          approved = true;
          break;
        }

        await onStart(reviewLabel);
        await notify(`**Starting reviewer** (cycle ${fixCycles + 1}) — independent verification...`);

        // Choose prompt: first cycle uses phase.prompt, subsequent use re_review_prompt
        const reviewPromptPath =
          fixCycles === 0 ? phase.prompt : loop.on_request_changes.re_review_prompt;
        const reviewPrompt = renderPrompt(reviewPromptPath, { fixCycle: fixCycles });

        // Resolve model
        const reviewModelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
        const reviewModel = reviewModelRaw || modelFor("reviewer");

        const rr = await runPhase(
          reviewLabel,
          `${taskId}-${reviewLabel}`,
          triggerId,
          reviewPrompt,
          config,
          db,
          reviewModel,
        );

        if (rr.skipped) {
          if (rr.reason === "running") {
            await notify(`**Reviewer** is already running — aborting to avoid duplicate work.`);
            return { success: false, phases };
          }
          approved = true;
          phases.push({ phase: reviewLabel, success: true, output: "Already completed" });
          break;
        }

        phases.push({ phase: reviewLabel, ...pickResult(rr.result) });
        await onEnd(reviewLabel, phases[phases.length - 1]);

        // Parse verdict
        const reviewerOutput = (rr.result.output || "").trim();
        const verdictMarker = reviewerOutput.match(
          /^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/im,
        );
        let isApproved: boolean;
        if (verdictMarker) {
          isApproved = verdictMarker[1].toUpperCase() === "APPROVED";
        } else {
          const upper = reviewerOutput.toUpperCase();
          const hasRequestChanges = /\bREQUEST_CHANGES\b/.test(upper);
          isApproved = !hasRequestChanges && /^APPROVED\b/.test(upper);
          console.warn(
            `[runner] Reviewer output missing VERDICT: marker — using fallback detection (isApproved=${isApproved})`,
          );
        }

        if (isApproved) {
          approved = true;
          persistPhase(reviewLabel, "APPROVED");
          await notify(`**Review: APPROVED** — proceeding to PR.`);
        } else if (fixCycles < MAX_CYCLES) {
          fixCycles++;
          persistPhase(reviewLabel, "REQUEST_CHANGES");

          // Approval gate before fix loop
          const gateKey = loop.approval_gate;
          if (gateKey && approvalConfig && db && workflowId) {
            const postGate =
              gateKey === "post_reviewer" ? approvalConfig.postReviewer : false;
            if (postGate) {
              const approvalId = randomUUID();
              db.createApproval({
                id: approvalId,
                workflowRunId: workflowId,
                gate: gateKey,
                summary: `Reviewer requested changes (cycle ${fixCycles}/${MAX_CYCLES}).\nVerdict: \`${issueDir}/reviewer-verdict.md\``,
                requestedBy: ctx.sender,
                createdAt: new Date().toISOString(),
              });
              db.updateWorkflowPhase(workflowId, "waiting_approval", {
                phase: "waiting_approval",
                timestamp: new Date().toISOString(),
                success: true,
                summary: `Waiting for approval: ${gateKey} (${approvalId})`,
              });
              db.pauseWorkflowRun(workflowId);
              await notify(
                `**Review: REQUEST_CHANGES** — approval required before fix loop.\n\n` +
                  `- Verdict: \`${issueDir}/reviewer-verdict.md\`\n\n` +
                  `**To proceed with fixes:** comment \`@last-light approve\`\n` +
                  `**To abort:** comment \`@last-light reject [reason]\``,
              );
              return { success: true, phases, paused: true };
            }
          }

          await notify(
            `**Review: REQUEST_CHANGES** — fixing issues (cycle ${fixCycles}/${MAX_CYCLES})...`,
          );

          // Run fix phase
          const fixLabel = `fix_loop_${fixCycles}`;
          await onStart(fixLabel);
          await notify(
            `**Starting fix loop** (cycle ${fixCycles}/${MAX_CYCLES}) — addressing reviewer feedback...`,
          );

          const fixModelRaw = loop.on_request_changes.fix_model
            ? renderTemplate(loop.on_request_changes.fix_model, ctx)
            : undefined;
          const fixModel = fixModelRaw || modelFor("fix");

          const fixPromptRendered = renderPrompt(loop.on_request_changes.fix_prompt, {
            fixCycle: fixCycles,
          });

          const fr = await runPhase(
            fixLabel,
            `${taskId}-fix${fixCycles}`,
            triggerId,
            fixPromptRendered,
            config,
            db,
            fixModel,
          );

          if (fr.skipped) {
            if (fr.reason === "running") {
              await notify(`**Fix loop** is already running — aborting.`);
              return { success: false, phases };
            }
            phases.push({ phase: fixLabel, success: true, output: "Already completed" });
          } else {
            phases.push({ phase: fixLabel, ...pickResult(fr.result) });
            await onEnd(fixLabel, phases[phases.length - 1]);

            if (!fr.result.success) {
              if (!isTerminated(fr.result.error)) {
                await notify(
                  `Fix cycle ${fixCycles} failed. Proceeding to PR with known issues.`,
                );
              }
              break;
            }
            persistPhase(fixLabel);
          }
        } else {
          persistPhase(reviewLabel, "REQUEST_CHANGES — max cycles reached");
          await notify(
            `**Review: REQUEST_CHANGES** after ${MAX_CYCLES} fix cycles. Proceeding with remaining issues noted.`,
          );
          break;
        }
      }

      // Update context for the PR phase with fix cycle information
      (ctx as Record<string, unknown>)["_approved"] = approved;
      (ctx as Record<string, unknown>)["_fixCycles"] = fixCycles;
      continue;
    }

    // ── Standard (non-looping) agent phase ───────────────────────────────
    if (!shouldRun(phaseName)) continue;

    await onStart(phaseName);

    // Special phase-specific notifications
    if (phaseName === "executor") {
      await notify(`**Starting executor** — implementing the architect's plan...`);
    } else if (phaseName === "pr") {
      await notify(`**Creating PR** — packaging changes for review...`);
    }

    // Resolve model
    const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
    const model = modelRaw || modelFor(phaseName);

    // Build extra context for the phase's prompt
    let extraCtx: Partial<TemplateContext> = {};

    if (phaseName === "pr") {
      // Compute reviewer note and doc links for PR phase
      const approved = (ctx as Record<string, unknown>)["_approved"] as boolean | undefined;
      const fixCycles = (ctx as Record<string, unknown>)["_fixCycles"] as number | undefined ?? 0;

      const reviewerNote =
        approved === false
          ? `\n\nNote: There are unresolved reviewer issues after ${fixCycles} fix cycles. See reviewer-verdict.md on the branch.`
          : "";

      const branchEncoded = encodeURIComponent(branch);
      const docs = [
        { file: "guardrails-report.md", label: "Guardrails report" },
        { file: "architect-plan.md", label: "Architect plan" },
        { file: "executor-summary.md", label: "Executor summary" },
        { file: "reviewer-verdict.md", label: "Reviewer verdict" },
        { file: "status.md", label: "Status" },
      ];
      const docLinks = docs
        .map(
          (d) =>
            `  - [${d.label}](https://github.com/${ctx.owner}/${ctx.repo}/blob/${branchEncoded}/${issueDir}/${d.file})`,
        )
        .join("\n");

      extraCtx = { reviewerNote, docLinks };
    }

    const prompt = renderPrompt(phase.prompt, extraCtx);

    const pr = await runPhase(phaseName, `${taskId}-${phaseName}`, triggerId, prompt, config, db, model);

    if (pr.skipped) {
      if (pr.reason === "running") {
        await notify(`**${phaseName}** phase is already running — aborting to avoid duplicate work.`);
        return { success: false, phases };
      }
      phases.push({ phase: phaseName, success: true, output: "Already completed" });
      if (phaseName === "executor") {
        await notify(`**Executor** already completed — proceeding to review...`);
      }
    } else {
      phases.push({ phase: phaseName, ...pickResult(pr.result) });
      await onEnd(phaseName, phases[phases.length - 1]);

      if (!pr.result.success) {
        if (!isTerminated(pr.result.error)) {
          await notify(`**${phaseName}** phase failed — unable to complete.`);
        }
        failWorkflow(pr.result.error);
        return { success: false, phases };
      }

      // Check on_output rules
      if (phase.on_output) {
        const outputUpper = (pr.result.output?.toUpperCase() || "");

        if (phase.on_output.contains_BLOCKED && outputUpper.includes("BLOCKED")) {
          const rule = phase.on_output.contains_BLOCKED;
          const hasUnlessLabel =
            rule.unless_label && ctx.issueLabels.includes(rule.unless_label);

          if (hasUnlessLabel || isBootstrapContext(ctx)) {
            // Bootstrap bypass — fall through
            await notify(
              `**Guardrails check: BLOCKED** — but this is a bootstrap task ` +
                `(label \`${rule.unless_label || ctx.bootstrapLabel}\` or "guardrails:" title prefix detected). ` +
                `Proceeding with the build cycle so the architect can plan, and the ` +
                `executor can install, the missing tooling. The guardrails report at ` +
                `\`${issueDir}/guardrails-report.md\` lists what's missing.`,
            );
          } else if (rule.action === "fail") {
            db?.markLatestAsFailed(
              `build:${phaseName}`,
              triggerId,
              "BLOCKED: missing foundational tooling",
            );
            failWorkflow("guardrails BLOCKED");
            await notify(
              `**${rule.message || "Guardrails check: BLOCKED"}** — missing foundational tooling.\n\n` +
                `See the guardrails report on branch \`${branch}\` at \`${issueDir}/guardrails-report.md\`. ` +
                `Once you've added the missing tooling, ask me to build this issue again — the check will re-run against the current repo state.`,
            );
            return { success: false, phases };
          }
        }
      }

      // Approval gate
      if (phase.approval_gate && approvalConfig && db && workflowId) {
        const gateKey = phase.approval_gate;
        const postGate =
          gateKey === "post_architect"
            ? approvalConfig.postArchitect
            : gateKey === "post_reviewer"
              ? approvalConfig.postReviewer
              : false;

        if (postGate) {
          const approvalId = randomUUID();
          db.createApproval({
            id: approvalId,
            workflowRunId: workflowId,
            gate: gateKey,
            summary: `${phaseName} plan ready.\n- Branch: \`${branch}\`\n- Plan: \`${issueDir}/architect-plan.md\``,
            requestedBy: ctx.sender,
            createdAt: new Date().toISOString(),
          });
          db.updateWorkflowPhase(workflowId, "waiting_approval", {
            phase: "waiting_approval",
            timestamp: new Date().toISOString(),
            success: true,
            summary: `Waiting for approval: ${gateKey} (${approvalId})`,
          });
          db.pauseWorkflowRun(workflowId);

          if (gateKey === "post_architect") {
            await notify(
              `**Architect analysis complete** — approval required before implementation.\n\n` +
                `- Branch: \`${branch}\`\n` +
                `- Plan: \`${issueDir}/architect-plan.md\`\n\n` +
                `**To proceed:** comment \`@last-light approve\`\n` +
                `**To abort:** comment \`@last-light reject [reason]\``,
            );
          }
          return { success: true, phases, paused: true };
        }
      }

      persistPhase(phaseName);

      // Phase-specific notifications after success
      if (phaseName === "guardrails") {
        await notify(`**Guardrails check: READY** — verified. Starting architect analysis...`);
      } else if (phaseName === "architect") {
        await notify(
          `**Architect analysis complete.**\n` +
            `- Branch: \`${branch}\`\n` +
            `- Plan: \`${issueDir}/architect-plan.md\`\n\n` +
            `Starting implementation...`,
        );
      } else if (phaseName === "executor") {
        await notify(
          `**Implementation complete.** Running independent review...\n` +
            `- Branch: \`${branch}\`\n` +
            `- Summary: \`${issueDir}/executor-summary.md\``,
        );
      }
    }
  }

  // ── Handle PR phase completion ────────────────────────────────────────────
  const prPhase = phases.find((p) => p.phase === "pr");
  const prOutput = prPhase?.output || "";
  const prMatch = prOutput.match(/#(\d+)/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : undefined;
  const prSuccess = prPhase ? prPhase.success : true;

  if (prSuccess) {
    const setPhase = definition.phases.find((p) => p.name === "pr")?.on_success?.set_phase;
    if (setPhase) {
      persistPhase(setPhase, prNumber ? `PR #${prNumber}` : undefined);
    }
    if (db && workflowId) {
      db.finishWorkflowRun(workflowId, "succeeded");
    }
  } else {
    failWorkflow(prPhase?.error || "PR creation failed");
  }

  if (prNumber) {
    await notify(`**PR created:** #${prNumber}\n\nBuild cycle complete.`);
  }

  return { success: prSuccess, phases, prNumber };
}

/** Check if the request context represents a bootstrap task. */
function isBootstrapContext(ctx: TemplateContext): boolean {
  if (ctx.issueLabels.includes(ctx.bootstrapLabel)) return true;
  const title = (ctx.issueTitle || "").toLowerCase();
  return title.startsWith("guardrails:") || title.startsWith("[guardrails]");
}
