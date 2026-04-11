import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import type { ExecutorConfig, ExecutionResult } from "../engine/executor.js";
import { executeAgent } from "../engine/executor.js";
import type { StateDb } from "../state/db.js";
import type { PhaseHistoryEntry } from "../state/db.js";
import type { ModelConfig } from "../config.js";
import { resolveModel } from "../config.js";
import { listRunningContainers } from "../admin/docker.js";
import type { AgentWorkflowDefinition, PhaseDefinition } from "./schema.js";
import { loadPromptTemplate } from "./loader.js";
import { renderTemplate, type TemplateContext } from "./templates.js";
import { evalUntilExpression } from "./loop-eval.js";
import { buildDag, getReadyNodes, getNodesToSkip, isComplete, type DagNode } from "./dag.js";

/**
 * Load a skill's SKILL.md instructions from skills/<name>/SKILL.md, falling
 * back to .claude/skills/<name>/SKILL.md if the project-local copy isn't
 * present (matches the legacy executeSkill lookup order).
 */
function loadSkillInstructions(skillName: string): string {
  for (const base of [resolve("skills"), resolve(".claude/skills")]) {
    try {
      return readFileSync(join(base, skillName, "SKILL.md"), "utf-8");
    } catch {
      /* try next path */
    }
  }
  throw new Error(`Skill not found: skills/${skillName}/SKILL.md`);
}

/**
 * Build the agent prompt for a phase, handling both `prompt:` (template file)
 * and `skill:` (SKILL.md reference) phase definitions.
 *
 * Skill phases produce the same prompt shape the legacy executeSkill used:
 *     "Follow these skill instructions:\n\n<SKILL.md>\n\nContext:\n<key: value lines>"
 * Template variables ({{owner}}, {{issueNumber}}, etc.) are still rendered in
 * the SKILL.md content so skills can reference workflow context if they want.
 */
function buildPhasePrompt(
  phase: PhaseDefinition,
  ctx: TemplateContext,
  extraCtx?: Partial<TemplateContext>,
): string {
  const fullCtx = extraCtx ? { ...ctx, ...extraCtx } : ctx;

  if (phase.skill) {
    const skillContent = loadSkillInstructions(phase.skill);
    const renderedSkill = renderTemplate(skillContent, fullCtx);
    // Build a context block from the workflow context — same shape that the
    // legacy executeSkill produced, so existing skill instructions still work.
    const contextLines = Object.entries(fullCtx)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("\n");
    return `Follow these skill instructions:\n\n${renderedSkill}\n\nContext:\n${contextLines}`;
  }

  if (phase.prompt) {
    const template = loadPromptTemplate(phase.prompt);
    return renderTemplate(template, fullCtx);
  }

  throw new Error(`Phase "${phase.name}" has neither prompt: nor skill: — cannot build prompt`);
}

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
  // Generic loop iteration phases (e.g. "implement_iter_1") map to executor position
  if (phase.includes("_iter_")) return PHASE_ORDER.indexOf("executor");
  const idx = PHASE_ORDER.indexOf(phase as KnownPhase);
  return idx === -1 ? -1 : idx;
}

// ── Main workflow runner ─────────────────────────────────────────────────────

/** Returns true if any phase declares explicit dependencies — triggers DAG execution path. */
function hasDependencies(definition: AgentWorkflowDefinition): boolean {
  return definition.phases.some((p) => p.depends_on && p.depends_on.length > 0);
}

/**
 * Run a build workflow defined by a YAML definition.
 * Interprets phases, approval gates, and the reviewer loop generically.
 *
 * @param startFrom - Optional phase name to resume from. When provided (e.g. from the
 *   no-DB agent-based resume check), overrides the DB-derived resume point.
 */
export async function runWorkflow(
  definition: AgentWorkflowDefinition,
  ctx: TemplateContext,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db?: StateDb,
  models?: ModelConfig,
  approvalConfig?: ApprovalGateConfig,
  workflowId?: string,
  startFrom?: string,
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

  // Determine resume point: explicit override → DB-derived → default phase_0
  let resumeFrom = "phase_0";
  if (startFrom) {
    resumeFrom = startFrom;
  } else if (db && workflowId) {
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

  if (hasDependencies(definition)) {
    return runDagWorkflow(
      definition, ctx, config, callbacks, db, models, approvalConfig, workflowId,
      { phases, triggerId, notify, onStart, onEnd, modelFor, renderPrompt, persistPhase, failWorkflow },
    );
  }

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
    if (!phase.prompt && !phase.skill) {
      console.warn(`[runner] Phase "${phaseName}" has type=agent but neither prompt: nor skill: — skipping`);
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

        // Choose prompt: first cycle uses phase.prompt or phase.skill (via
        // buildPhasePrompt), subsequent cycles always use the re_review_prompt
        // template path defined in loop.on_request_changes.
        const reviewPrompt =
          fixCycles === 0
            ? buildPhasePrompt(phase, ctx, { fixCycle: fixCycles })
            : renderPrompt(loop.on_request_changes.re_review_prompt, { fixCycle: fixCycles });

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

    // ── Generic loop phase ────────────────────────────────────────────────
    if (phase.generic_loop) {
      const loop = phase.generic_loop;
      const MAX_ITER = loop.max_iterations;
      const MAX_PREV_OUTPUT_BYTES = 10 * 1024; // cap accumulated output at 10KB

      if (!shouldRun(phaseName)) {
        phases.push({ phase: phaseName, success: true, output: "Already completed" });
        continue;
      }

      let iteration = 0;
      let complete = false;
      let previousOutput = "";

      while (!complete && iteration < MAX_ITER) {
        iteration++;
        const iterLabel = `${phaseName}_iter_${iteration}`;

        await onStart(iterLabel);

        // Build prompt with loop context vars
        const iterCtx: Partial<TemplateContext> = {
          iteration,
          maxIterations: MAX_ITER,
          previousOutput: loop.fresh_context ? "" : previousOutput,
        };
        const prompt = buildPhasePrompt(phase, ctx, iterCtx);

        const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
        const model = modelRaw || modelFor(phaseName);

        const ir = await runPhase(
          iterLabel,
          `${taskId}-${iterLabel}`,
          triggerId,
          prompt,
          config,
          db,
          model,
        );

        if (ir.skipped) {
          if (ir.reason === "running") {
            await notify(`**${phaseName}** iteration ${iteration} is already running — aborting.`);
            return { success: false, phases };
          }
          // Already done — treat as complete
          phases.push({ phase: iterLabel, success: true, output: "Already completed" });
          complete = true;
          break;
        }

        phases.push({ phase: iterLabel, ...pickResult(ir.result) });
        await onEnd(iterLabel, phases[phases.length - 1]);

        if (!ir.result.success) {
          if (!isTerminated(ir.result.error)) {
            await notify(`**${phaseName}** iteration ${iteration} failed.`);
          }
          failWorkflow(ir.result.error);
          return { success: false, phases };
        }

        const iterOutput = ir.result.output || "";

        // Accumulate previousOutput (cap at MAX_PREV_OUTPUT_BYTES)
        if (!loop.fresh_context) {
          const combined = previousOutput ? `${previousOutput}\n${iterOutput}` : iterOutput;
          previousOutput = combined.length > MAX_PREV_OUTPUT_BYTES
            ? combined.slice(-MAX_PREV_OUTPUT_BYTES)
            : combined;
        }

        // Evaluate until expression
        let conditionMet = false;
        if (loop.until) {
          conditionMet = evalUntilExpression(loop.until, { output: iterOutput, ...Object.fromEntries(
            Object.entries(ctx).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string])
          )});
        }

        // Evaluate until_bash
        if (!conditionMet && loop.until_bash) {
          try {
            execSync(loop.until_bash, { timeout: 30_000, stdio: "pipe", cwd: config.sandboxDir ?? config.cwd });
            conditionMet = true; // exit 0
          } catch {
            conditionMet = false; // non-zero exit
          }
        }

        if (conditionMet) {
          complete = true;
          persistPhase(iterLabel, `iteration ${iteration} — condition met`);
          break;
        }

        // Interactive gate between iterations
        if (loop.interactive && !complete && db && workflowId) {
          const gateMsg = loop.gate_message
            ? loop.gate_message
            : `Loop iteration ${iteration}/${MAX_ITER} complete. Approve to continue.`;
          const approvalId = randomUUID();
          db.createApproval({
            id: approvalId,
            workflowRunId: workflowId,
            gate: `${phaseName}_iter_${iteration}`,
            summary: gateMsg,
            requestedBy: ctx.sender,
            createdAt: new Date().toISOString(),
          });
          db.updateWorkflowPhase(workflowId, "waiting_approval", {
            phase: "waiting_approval",
            timestamp: new Date().toISOString(),
            success: true,
            summary: `Waiting for approval: ${phaseName}_iter_${iteration} (${approvalId})`,
          });
          db.pauseWorkflowRun(workflowId);
          await notify(
            `**${phaseName} iteration ${iteration}/${MAX_ITER} complete** — approval required to continue.\n\n` +
              `${gateMsg}\n\n` +
              `**To continue:** comment \`@last-light approve\`\n` +
              `**To abort:** comment \`@last-light reject [reason]\``,
          );
          return { success: true, phases, paused: true };
        }

        persistPhase(iterLabel);
      }

      if (!complete) {
        await notify(
          `**${phaseName}** reached max iterations (${MAX_ITER}) without satisfying the completion condition.`,
        );
      }

      // Expose loop outcome in context
      (ctx as Record<string, unknown>)[`_${phaseName}_loopCompleted`] = complete;
      (ctx as Record<string, unknown>)[`_${phaseName}_iterations`] = iteration;
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

    const prompt = buildPhasePrompt(phase, ctx, extraCtx);

    const pr = await runPhase(phaseName, `${taskId}-${phaseName}`, triggerId, prompt, config, db, model);

    if (pr.skipped) {
      if (pr.reason === "running") {
        await notify(`**${phaseName}** phase is already running — aborting to avoid duplicate work.`);
        return { success: false, phases };
      }
      phases.push({ phase: phaseName, success: true, output: "Already completed" });
      // Persist a phase_history entry even when the phase was deduped, so
      // the dashboard's pipeline view shows the phase as 'done' instead of
      // stuck on 'active'/pending. Without this the run looks half-finished
      // even though it succeeded.
      persistPhase(phaseName, "Already completed (deduplicated)");
      await onEnd(phaseName, { phase: phaseName, success: true, output: "Already completed" });
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

/** Shared runner context threaded into DAG execution (avoids re-deriving these). */
interface DagRunnerCtx {
  phases: PhaseResult[];
  triggerId: string;
  notify: (msg: string) => Promise<void>;
  onStart: (phase: string) => Promise<void>;
  onEnd: (phase: string, result: PhaseResult) => Promise<void>;
  modelFor: (taskType: string) => string | undefined;
  renderPrompt: (promptPath: string, extraCtx?: Partial<TemplateContext>) => string;
  persistPhase: (phase: string, summary?: string) => void;
  failWorkflow: (errorMsg?: string) => void;
}

/**
 * DAG-based workflow execution. Called when any phase declares `depends_on`.
 * Runs independent phases concurrently via Promise.allSettled.
 */
async function runDagWorkflow(
  definition: AgentWorkflowDefinition,
  ctx: TemplateContext,
  config: ExecutorConfig,
  callbacks: RunnerCallbacks,
  db: StateDb | undefined,
  models: ModelConfig | undefined,
  approvalConfig: ApprovalGateConfig | undefined,
  workflowId: string | undefined,
  runnerCtx: DagRunnerCtx,
): Promise<WorkflowResult> {
  const { phases, triggerId, notify, onStart, onEnd, modelFor, renderPrompt, persistPhase, failWorkflow } = runnerCtx;
  const { taskId } = ctx;

  const dag = buildDag(definition.phases);
  const phaseMap = new Map(definition.phases.map((p) => [p.name, p]));
  // phase outputs: keyed by output_var name
  const outputs: Record<string, string> = {};

  /**
   * Execute a single standard agent phase (no loop). Returns PhaseResult and
   * whether the workflow should pause (approval gate).
   */
  async function executeSinglePhase(
    phase: NonNullable<ReturnType<typeof phaseMap.get>>,
    phaseName: string,
  ): Promise<{ result: PhaseResult; paused?: boolean }> {
    // Build context with current phase outputs for ${name.output} substitution
    const phaseCtx: Partial<TemplateContext> = { phaseOutputs: { ...outputs } };
    const prompt = buildPhasePrompt(phase, ctx, phaseCtx);
    const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
    const model = modelRaw || modelFor(phaseName);

    const pr = await runPhase(phaseName, `${taskId}-${phaseName}`, triggerId, prompt, config, db, model);

    if (pr.skipped) {
      return { result: { phase: phaseName, success: true, output: "Already completed" } };
    }

    const result: PhaseResult = { phase: phaseName, ...pickResult(pr.result) };

    if (!pr.result.success) {
      return { result };
    }

    // Check on_output rules
    if (phase.on_output?.contains_BLOCKED && (pr.result.output?.toUpperCase() || "").includes("BLOCKED")) {
      const rule = phase.on_output.contains_BLOCKED;
      if (rule.action === "fail") {
        db?.markLatestAsFailed(`build:${phaseName}`, triggerId, "BLOCKED");
        failWorkflow("guardrails BLOCKED");
        await notify(`**${rule.message || "Guardrails: BLOCKED"}**`);
        return { result: { phase: phaseName, success: false, output: pr.result.output ?? "", error: "BLOCKED" } };
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
          summary: `${phaseName} complete.`,
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
          `**${phaseName} complete** — approval required to continue.\n\n` +
            `**To proceed:** comment \`@last-light approve\`\n` +
            `**To abort:** comment \`@last-light reject [reason]\``,
        );
        return { result, paused: true };
      }
    }

    persistPhase(phaseName);
    return { result };
  }

  // ── Main DAG execution loop ────────────────────────────────────────────────

  while (!isComplete(dag)) {
    // First, mark nodes that should be skipped (trigger rule fails but deps are terminal)
    const toSkip = getNodesToSkip(dag);
    for (const node of toSkip) {
      node.status = "skipped";
      phases.push({ phase: node.name, success: true, output: "Skipped (trigger rule not satisfied)" });
      if (db && workflowId) {
        db.updateNodeStatus(workflowId, node.name, "skipped");
      }
    }

    const ready = getReadyNodes(dag);

    if (ready.length === 0) {
      if (toSkip.length === 0) break; // stuck (shouldn't happen in a valid DAG)
      continue; // only had skips — loop to process downstream
    }

    // Mark all ready nodes as running before dispatching
    for (const node of ready) {
      node.status = "running";
      if (db && workflowId) {
        db.updateNodeStatus(workflowId, node.name, "running");
      }
    }

    // Dispatch all ready nodes concurrently
    const nodePromises = ready.map(async (node) => {
      try {
      const phase = phaseMap.get(node.name)!;
      await onStart(node.name);

      // Context phase — immediate
      if (phase.type === "context" || !phase.type) {
        const r: PhaseResult = { phase: node.name, success: true, output: "Context assembled" };
        await onEnd(node.name, r);
        return { node, result: r, paused: false, alreadyPushed: false };
      }

      // Phase with neither prompt nor skill — skip
      if (!phase.prompt && !phase.skill) {
        console.warn(`[dag] Phase "${node.name}" has type=agent but neither prompt: nor skill: — skipping`);
        const r: PhaseResult = { phase: node.name, success: true, output: "Skipped (no prompt or skill)" };
        return { node, result: r, paused: false, alreadyPushed: false };
      }

      // Loop phase (reviewer-style) — run sequentially as a single DAG node
      if (phase.loop) {
        const loop = phase.loop;
        const MAX_CYCLES = loop.max_cycles;
        let approved = false;
        let fixCycles = 0;

        while (!approved && fixCycles <= MAX_CYCLES) {
          const reviewLabel = fixCycles === 0 ? node.name : `${node.name}_${fixCycles + 1}`;
          // First cycle uses phase.prompt or phase.skill via buildPhasePrompt;
          // subsequent cycles always use the re_review_prompt template path.
          const reviewPrompt =
            fixCycles === 0
              ? buildPhasePrompt(phase, ctx, { phaseOutputs: { ...outputs }, fixCycle: fixCycles })
              : renderPrompt(loop.on_request_changes.re_review_prompt, { phaseOutputs: { ...outputs }, fixCycle: fixCycles });
          const reviewModelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
          const reviewModel = reviewModelRaw || modelFor("reviewer");

          const rr = await runPhase(reviewLabel, `${taskId}-${reviewLabel}`, triggerId, reviewPrompt, config, db, reviewModel);
          if (rr.skipped) {
            approved = true;
            phases.push({ phase: reviewLabel, success: true, output: "Already completed" });
            break;
          }

          phases.push({ phase: reviewLabel, ...pickResult(rr.result) });
          await onEnd(reviewLabel, phases[phases.length - 1]);

          const reviewerOutput = (rr.result.output || "").trim();
          const verdictMarker = reviewerOutput.match(/^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/im);
          const isApproved = verdictMarker
            ? verdictMarker[1].toUpperCase() === "APPROVED"
            : !(/\bREQUEST_CHANGES\b/.test(reviewerOutput.toUpperCase())) && /^APPROVED\b/.test(reviewerOutput.toUpperCase());

          if (isApproved) {
            approved = true;
          } else if (fixCycles < MAX_CYCLES) {
            fixCycles++;
            const fixLabel = `fix_loop_${fixCycles}`;
            const fixPromptRendered = renderPrompt(loop.on_request_changes.fix_prompt, { phaseOutputs: { ...outputs }, fixCycle: fixCycles });
            const fixModelRaw = loop.on_request_changes.fix_model ? renderTemplate(loop.on_request_changes.fix_model, ctx) : undefined;
            const fixModel = fixModelRaw || modelFor("fix");
            const fr = await runPhase(fixLabel, `${taskId}-fix${fixCycles}`, triggerId, fixPromptRendered, config, db, fixModel);
            if (!fr.skipped) {
              phases.push({ phase: fixLabel, ...pickResult(fr.result) });
              await onEnd(fixLabel, phases[phases.length - 1]);
            }
          } else {
            break;
          }
        }

        const loopResult: PhaseResult = { phase: node.name, success: approved, output: approved ? "Approved" : "Request changes" };
        (ctx as Record<string, unknown>)["_approved"] = approved;
        (ctx as Record<string, unknown>)["_fixCycles"] = fixCycles;
        return { node, result: loopResult, paused: false, alreadyPushed: true };
      }

      // Generic loop phase
      if (phase.generic_loop) {
        const loop = phase.generic_loop;
        const MAX_ITER = loop.max_iterations;
        const MAX_PREV_OUTPUT_BYTES = 10 * 1024;
        let iteration = 0;
        let complete = false;
        let previousOutput = "";

        while (!complete && iteration < MAX_ITER) {
          iteration++;
          const iterLabel = `${node.name}_iter_${iteration}`;
          const iterCtx: Partial<TemplateContext> = {
            iteration,
            maxIterations: MAX_ITER,
            previousOutput: loop.fresh_context ? "" : previousOutput,
            phaseOutputs: { ...outputs },
          };
          const iterPrompt = buildPhasePrompt(phase, ctx, iterCtx);
          const modelRaw = phase.model ? renderTemplate(phase.model, ctx) : undefined;
          const model = modelRaw || modelFor(node.name);

          const ir = await runPhase(iterLabel, `${taskId}-${iterLabel}`, triggerId, iterPrompt, config, db, model);
          if (ir.skipped) { complete = true; break; }

          phases.push({ phase: iterLabel, ...pickResult(ir.result) });
          await onEnd(iterLabel, phases[phases.length - 1]);

          if (!ir.result.success) {
            failWorkflow(ir.result.error);
            return { node, result: { phase: node.name, success: false, output: "", error: ir.result.error }, paused: false, alreadyPushed: true };
          }

          const iterOutput = ir.result.output || "";
          if (!loop.fresh_context) {
            const combined = previousOutput ? `${previousOutput}\n${iterOutput}` : iterOutput;
            previousOutput = combined.length > MAX_PREV_OUTPUT_BYTES ? combined.slice(-MAX_PREV_OUTPUT_BYTES) : combined;
          }

          let conditionMet = false;
          if (loop.until) {
            conditionMet = evalUntilExpression(loop.until, { output: iterOutput, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, v as string])) });
          }
          if (!conditionMet && loop.until_bash) {
            try { execSync(loop.until_bash, { timeout: 30_000, stdio: "pipe", cwd: config.sandboxDir ?? config.cwd }); conditionMet = true; }
            catch { conditionMet = false; }
          }
          if (conditionMet) { complete = true; }
        }

        if (!complete) {
          await notify(`**${node.name}** reached max iterations (${MAX_ITER}) without satisfying the completion condition.`);
        }
        (ctx as Record<string, unknown>)[`_${node.name}_loopCompleted`] = complete;
        (ctx as Record<string, unknown>)[`_${node.name}_iterations`] = iteration;
        return { node, result: { phase: node.name, success: true, output: previousOutput || "" }, paused: false, alreadyPushed: true };
      }

      // Standard agent phase
      const { result, paused } = await executeSinglePhase(phase, node.name);
      await onEnd(node.name, result);
      return { node, result, paused: paused ?? false, alreadyPushed: false };
      } catch (err) {
        console.error(`[dag] Phase "${node.name}" threw unexpectedly:`, err);
        const result: PhaseResult = { phase: node.name, success: false, error: String(err), output: "" };
        return { node, result, paused: false, alreadyPushed: false };
      }
    });

    const settled = await Promise.allSettled(nodePromises);

    let anyPaused = false;
    for (const settledItem of settled) {
      if (settledItem.status === "rejected") {
        console.error("[dag] Phase promise rejected:", settledItem.reason);
        continue;
      }

      const { node, result, paused, alreadyPushed } = settledItem.value;

      if (!alreadyPushed) {
        phases.push(result);
      }

      if (paused) {
        anyPaused = true;
        node.status = "succeeded"; // treat paused as succeeded so downstream trigger rules fire correctly — the workflow will resume from this node's successors after approval
        continue;
      }

      node.status = result.success ? "succeeded" : "failed";
      if (db && workflowId) {
        db.updateNodeStatus(workflowId, node.name, node.status);
      }

      // Store output_var if specified
      const phaseDef = phaseMap.get(node.name)!;
      if (phaseDef.output_var && result.output) {
        outputs[phaseDef.output_var] = result.output;
      }
    }

    if (anyPaused) {
      return { success: true, phases, paused: true };
    }
  }

  // Determine overall success
  const anyFailed = phases.some((p) => !p.success);
  return { success: !anyFailed, phases };
}

/** Check if the request context represents a bootstrap task. */
function isBootstrapContext(ctx: TemplateContext): boolean {
  if (ctx.issueLabels.includes(ctx.bootstrapLabel)) return true;
  const title = (ctx.issueTitle || "").toLowerCase();
  return title.startsWith("guardrails:") || title.startsWith("[guardrails]");
}
