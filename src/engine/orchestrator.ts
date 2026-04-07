import type { ExecutorConfig, ExecutionResult } from "./executor.js";
import { executeAgent } from "./executor.js";
import type { StateDb } from "../state/db.js";
import { listRunningContainers } from "../admin/docker.js";
import { randomUUID } from "crypto";

/**
 * Build request context.
 */
export interface BuildRequest {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  commentBody?: string;
  sender: string;
}

interface PhaseResult {
  phase: string;
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Orchestrates the Architect → Executor → Reviewer cycle.
 *
 * Each phase runs via executeAgent which automatically uses Docker sandboxes
 * when available, falling back to direct Agent SDK execution.
 */
/**
 * Check if an error was caused by manual termination (container killed).
 */
function isTerminated(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes("terminated") ||
    lower.includes("killed") ||
    lower.includes("exit undefined") ||
    lower.includes("container") && lower.includes("not running");
}

/**
 * Phase ordering for resume logic.
 * Each phase in the build cycle, in order. If status.md reports a completed phase,
 * the orchestrator skips to the next one.
 */
const PHASE_ORDER = ["phase_0", "guardrails", "architect", "executor", "reviewer", "complete"] as const;
type Phase = (typeof PHASE_ORDER)[number];

function phaseIndex(phase: string): number {
  // Normalize: fix_loop_N → executor (we re-run from reviewer)
  if (phase.startsWith("fix_loop")) return PHASE_ORDER.indexOf("executor");
  const idx = PHASE_ORDER.indexOf(phase as Phase);
  return idx === -1 ? -1 : idx;
}

/**
 * Check if a sandbox container is actually running for a given taskId prefix.
 * Container names: lastlight-sandbox-{taskId}-{uuid}
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
 * Run a phase with DB-tracked deduplication.
 * Returns null if the phase is already running or already completed successfully.
 */
async function runPhase(
  phaseName: string,
  taskId: string,
  triggerId: string,
  prompt: string,
  config: ExecutorConfig,
  db?: StateDb,
): Promise<{ result: ExecutionResult; skipped: false } | { skipped: true; reason: "running" | "done" }> {
  if (db) {
    const status = db.shouldRunPhase(`build:${phaseName}`, triggerId);

    if (status === "running") {
      // Verify the container is actually alive
      const alive = await isContainerAlive(taskId);
      if (alive) {
        console.log(`[orchestrator] Phase ${phaseName} is already running (container alive) — skipping`);
        return { skipped: true, reason: "running" };
      }
      // Container died — clean up stale record
      console.log(`[orchestrator] Phase ${phaseName} was running but container is dead — cleaning up`);
      db.markStaleAsFailed(`build:${phaseName}`, triggerId);
    } else if (status === "done") {
      console.log(`[orchestrator] Phase ${phaseName} already completed successfully — skipping`);
      return { skipped: true, reason: "done" };
    }

    // Record start
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

    const result = await executeAgent(prompt, config, { taskId });

    db.recordFinish(executionId, {
      success: result.success,
      error: result.error,
      turns: result.turns,
      durationMs: result.durationMs,
    });

    return { result, skipped: false };
  }

  // No DB — just run
  const result = await executeAgent(prompt, config, { taskId });
  return { result, skipped: false };
}

export async function runBuildCycle(
  request: BuildRequest,
  config: ExecutorConfig,
  callbacks?: {
    onPhaseStart?: (phase: string) => Promise<void>;
    onPhaseEnd?: (phase: string, result: PhaseResult) => Promise<void>;
    postComment?: (body: string) => Promise<void>;
  },
  db?: StateDb,
): Promise<{ success: boolean; phases: PhaseResult[]; prNumber?: number }> {
  const { owner, repo, issueNumber } = request;
  const phases: PhaseResult[] = [];
  const branch = `lastlight/${issueNumber}-${slugify(request.issueTitle)}`;
  const taskId = `${repo}-${issueNumber}`;

  const notify = callbacks?.postComment || (async () => {});
  const onStart = callbacks?.onPhaseStart || (async () => {});
  const onEnd = callbacks?.onPhaseEnd || (async () => {});

  console.log(`[orchestrator] Build cycle for ${owner}/${repo}#${issueNumber}`);
  await notify(`Acknowledged — starting build cycle for #${issueNumber}. Checking for prior progress...`);

  // ── Resume check ────────────────────────────────────────────────
  // Check if a branch already exists with status.md to resume from.
  let resumeFrom: Phase = "phase_0";

  const resumeResult = await executeAgent(
    buildResumeCheckPrompt(request, branch),
    config, { taskId: `${taskId}-resume-check` }
  );

  if (resumeResult.success && resumeResult.output) {
    const output = resumeResult.output;
    // Parse current_phase from output
    const phaseMatch = output.match(/current_phase:\s*(\S+)/);
    if (phaseMatch) {
      const completedPhase = phaseMatch[1];
      const completedIdx = phaseIndex(completedPhase);
      if (completedIdx >= 0 && completedIdx < PHASE_ORDER.length - 1) {
        resumeFrom = PHASE_ORDER[completedIdx + 1];
        console.log(`[orchestrator] Resuming from ${resumeFrom} (last completed: ${completedPhase})`);
        await notify(
          `**Resuming build cycle** for #${issueNumber} from **${resumeFrom}** phase.\n` +
          `Previous progress found on branch \`${branch}\` (last completed: \`${completedPhase}\`).`
        );
      }
    }

    // Check if already complete
    if (output.includes("current_phase: complete")) {
      await notify(`Build cycle for #${issueNumber} is already complete. See the existing PR on branch \`${branch}\`.`);
      return { success: true, phases: [{ phase: "resume", success: true, output: "Already complete" }] };
    }
  }

  const shouldRun = (phase: Phase) => phaseIndex(phase) >= phaseIndex(resumeFrom);

  // ── Phase 0: Acknowledge + Context Assembly ────────────────────

  const contextSnapshot = `
Task: ${request.commentBody || request.issueBody}
Issue: ${owner}/${repo}#${issueNumber} — ${request.issueTitle}
Issue body: ${request.issueBody}
Requested by: ${request.sender}
Branch: ${branch}
`.trim();

  if (shouldRun("phase_0")) {
    await onStart("phase_0");
    phases.push({ phase: "phase_0", success: true, output: "Context assembled" });
    await onEnd("phase_0", phases[phases.length - 1]);
  }

  const triggerId = `${owner}/${repo}#${issueNumber}`;

  // ── Guardrails Check ──────────────────────────────────────────

  if (shouldRun("guardrails")) {
    await onStart("guardrails");
    const gr = await runPhase("guardrails", `${taskId}-guardrails`, triggerId,
      buildGuardrailsPrompt(request, branch), config, db);

    if (gr.skipped) {
      if (gr.reason === "running") {
        await notify(`**Guardrails check** is already running in another session — waiting for it to complete.`);
        return { success: false, phases };
      }
      phases.push({ phase: "guardrails", success: true, output: "Already completed" });
    } else {
      phases.push({ phase: "guardrails", ...pick(gr.result) });
      await onEnd("guardrails", phases[phases.length - 1]);

      const guardrailsOutput = gr.result.output?.toUpperCase() || "";
      if (guardrailsOutput.includes("BLOCKED")) {
        await notify(
          `**Guardrails check: BLOCKED** — missing foundational tooling.\n\n` +
          `See the guardrails report on branch \`${branch}\` at \`.lastlight/issue-${issueNumber}/guardrails-report.md\``
        );
        return { success: false, phases };
      }

      if (gr.result.success) {
        await notify(`**Guardrails check: READY** — verified. Starting architect analysis...`);
      } else {
        await notify(`**Guardrails check completed with warnings.** Proceeding...`);
      }
    }
  }

  // ── Phase 1: Architect ─────────────────────────────────────────

  if (shouldRun("architect")) {
    await onStart("architect");
    const ar = await runPhase("architect", `${taskId}-architect`, triggerId,
      buildArchitectPrompt(request, branch, contextSnapshot), config, db);

    if (ar.skipped) {
      if (ar.reason === "running") {
        await notify(`**Architect** phase is already running — aborting to avoid duplicate work.`);
        return { success: false, phases };
      }
      phases.push({ phase: "architect", success: true, output: "Already completed" });
    } else {
      phases.push({ phase: "architect", ...pick(ar.result) });
      await onEnd("architect", phases[phases.length - 1]);

      if (!ar.result.success) {
        if (!isTerminated(ar.result.error)) {
          await notify(`Architect analysis failed — unable to complete analysis.`);
        }
        return { success: false, phases };
      }

      await notify(
        `**Architect analysis complete.**\n` +
        `- Branch: \`${branch}\`\n` +
        `- Plan: \`.lastlight/issue-${issueNumber}/architect-plan.md\`\n\n` +
        `Starting implementation...`
      );
    }
  }

  // ── Phase 2: Executor ──────────────────────────────────────────

  if (shouldRun("executor")) {
    await onStart("executor");
    await notify(`**Starting executor** — implementing the architect's plan...`);
    const er = await runPhase("executor", `${taskId}-executor`, triggerId,
      buildExecutorPrompt(request, branch), config, db);

    if (er.skipped) {
      if (er.reason === "running") {
        await notify(`**Executor** phase is already running — aborting to avoid duplicate work.`);
        return { success: false, phases };
      }
      phases.push({ phase: "executor", success: true, output: "Already completed" });
      await notify(`**Executor** already completed — proceeding to review...`);
    } else {
      phases.push({ phase: "executor", ...pick(er.result) });
      await onEnd("executor", phases[phases.length - 1]);

      if (!er.result.success) {
        if (!isTerminated(er.result.error)) {
          await notify(`Executor implementation failed — unable to complete.`);
        }
        return { success: false, phases };
      }

      await notify(
        `**Implementation complete.** Running independent review...\n` +
        `- Branch: \`${branch}\`\n` +
        `- Summary: \`.lastlight/issue-${issueNumber}/executor-summary.md\``
      );
    }
  }

  // ── Phase 3: Reviewer + Fix Loop ───────────────────────────────

  let approved = false;
  let fixCycles = 0;
  const MAX_FIX_CYCLES = 2;

  while (!approved && fixCycles <= MAX_FIX_CYCLES) {
    const reviewLabel = fixCycles === 0 ? "reviewer" : `reviewer_${fixCycles + 1}`;
    await onStart(reviewLabel);
    await notify(`**Starting reviewer** (cycle ${fixCycles + 1}) — independent verification...`);

    const reviewPrompt = fixCycles === 0
      ? buildReviewerPrompt(request, branch)
      : buildReReviewPrompt(request, branch, fixCycles);
    const rr = await runPhase(reviewLabel, `${taskId}-${reviewLabel}`, triggerId,
      reviewPrompt, config, db);

    if (rr.skipped) {
      if (rr.reason === "running") {
        await notify(`**Reviewer** is already running — aborting to avoid duplicate work.`);
        return { success: false, phases };
      }
      // Reviewer already done — check if it approved
      approved = true; // Assume approved if we got past it
      phases.push({ phase: reviewLabel, success: true, output: "Already completed" });
      break;
    }

    phases.push({ phase: reviewLabel, ...pick(rr.result) });
    await onEnd(reviewLabel, phases[phases.length - 1]);

    const verdict = rr.result.output?.toUpperCase() || "";
    if (verdict.includes("APPROVED")) {
      approved = true;
      await notify(`**Review: APPROVED** — proceeding to PR.`);
    } else if (fixCycles < MAX_FIX_CYCLES) {
      fixCycles++;
      await notify(`**Review: REQUEST_CHANGES** — fixing issues (cycle ${fixCycles}/${MAX_FIX_CYCLES})...`);

      await onStart(`fix_loop_${fixCycles}`);
      await notify(`**Starting fix loop** (cycle ${fixCycles}/${MAX_FIX_CYCLES}) — addressing reviewer feedback...`);
      const fr = await runPhase(`fix_loop_${fixCycles}`, `${taskId}-fix${fixCycles}`, triggerId,
        buildFixPrompt(request, branch, fixCycles), config, db);

      if (fr.skipped) {
        if (fr.reason === "running") {
          await notify(`**Fix loop** is already running — aborting.`);
          return { success: false, phases };
        }
        phases.push({ phase: `fix_loop_${fixCycles}`, success: true, output: "Already completed" });
      } else {
        phases.push({ phase: `fix_loop_${fixCycles}`, ...pick(fr.result) });
        await onEnd(`fix_loop_${fixCycles}`, phases[phases.length - 1]);

        if (!fr.result.success) {
          if (!isTerminated(fr.result.error)) {
            await notify(`Fix cycle ${fixCycles} failed. Proceeding to PR with known issues.`);
          }
          break;
        }
      }
    } else {
      await notify(`**Review: REQUEST_CHANGES** after ${MAX_FIX_CYCLES} fix cycles. Proceeding with remaining issues noted.`);
      break;
    }
  }

  // ── Phase 5: Create PR ─────────────────────────────────────────

  await onStart("pr");
  await notify(`**Creating PR** — packaging changes for review...`);
  const prPhase = await runPhase("pr", `${taskId}-pr`, triggerId,
    buildPrPrompt(request, branch, approved, fixCycles), config, db);

  if (prPhase.skipped) {
    if (prPhase.reason === "running") {
      await notify(`**PR creation** is already running — aborting.`);
      return { success: false, phases };
    }
    phases.push({ phase: "pr", success: true, output: "Already completed" });
  } else {
    phases.push({ phase: "pr", ...pick(prPhase.result) });
    await onEnd("pr", phases[phases.length - 1]);
  }

  const prOutput = !prPhase.skipped ? prPhase.result.output : "";
  const prMatch = prOutput?.match(/#(\d+)/);
  const prNumber = prMatch ? parseInt(prMatch[1], 10) : undefined;

  if (prNumber) {
    await notify(`**PR created:** #${prNumber}\n\nBuild cycle complete.`);
  }

  const prSuccess = prPhase.skipped ? true : prPhase.result.success;
  return { success: prSuccess, phases, prNumber };
}

// ── Helpers ─────────────────────────────────────────────────────────

function pick(r: ExecutionResult) {
  return { success: r.success, output: r.output, error: r.error };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// ── Prompt Builders ─────────────────────────────────────────────────

function buildResumeCheckPrompt(req: BuildRequest, branch: string): string {
  return `Check if a build cycle already exists for this issue.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. Try: git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
   If the branch doesn't exist, output "current_phase: none" and stop.

2. If the branch exists, check for .lastlight/issue-${req.issueNumber}/status.md
   If it exists, read it and output its contents.
   If it doesn't exist, output "current_phase: none"

OUTPUT: The contents of status.md, or "current_phase: none" if no prior work exists.
Do NOT modify any files. This is a read-only check.`;
}

function buildGuardrailsPrompt(req: BuildRequest, branch: string): string {
  return `You are running a PRE-FLIGHT GUARDRAILS CHECK before implementation work begins.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. Try: git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
   If the branch doesn't exist yet: git clone https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo} && git checkout -b ${branch}
2. Read CLAUDE.md and AGENTS.md if they exist

SKIP CHECK — if .lastlight/issue-${req.issueNumber}/status.md already exists and contains
guardrails_status: READY, output "READY — guardrails already verified" and stop.

CHECK THESE GUARDRAILS:

1. **Test Framework** — Does the repo have a test runner (vitest, jest, pytest, cargo test, etc.)?
   Do test files exist? Does the test command actually run?

2. **Linting** — Is a linter configured (eslint, biome, ruff, clippy, etc.)?
   Does the lint command run?

3. **Type Checking** — Is type checking configured (tsconfig.json + tsc, mypy, cargo check, etc.)?
   Does the typecheck command run?

4. **CI Pipeline** (informational only) — Does .github/workflows/ exist with test/lint steps?

AFTER CHECKING:
1. mkdir -p .lastlight/issue-${req.issueNumber}
2. Write .lastlight/issue-${req.issueNumber}/guardrails-report.md with the status of each check
3. Write .lastlight/issue-${req.issueNumber}/status.md with current_phase: guardrails AND guardrails_status: READY or BLOCKED
4. git add .lastlight/ && git commit -m "docs: guardrails check for #${req.issueNumber}"
5. git push -u origin HEAD

IF ANY BLOCKING GUARDRAIL IS MISSING (no test framework at all, or tests completely broken):
- Use the MCP tool create_issue to create a guardrails issue in the repo
- Use add_issue_comment on issue #${req.issueNumber} to link the guardrails issue
- OUTPUT must include: BLOCKED

IF ALL CRITICAL GUARDRAILS ARE PRESENT (tests work, even if linting/types are missing):
- OUTPUT must include: READY

OUTPUT: Exactly one of READY or BLOCKED, followed by a brief summary of what was found.`;
}

function buildArchitectPrompt(req: BuildRequest, branch: string, context: string): string {
  return `You are the ARCHITECT. Analyze the codebase and produce an implementation plan.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
2. Read CLAUDE.md and AGENTS.md if they exist
3. Read .lastlight/issue-${req.issueNumber}/guardrails-report.md for pre-flight results

CONTEXT:
${context}

OUTPUT — write the plan to .lastlight/issue-${req.issueNumber}/architect-plan.md:
- Problem Statement (2-5 sentences with file:line references)
- Summary of what needs to change
- Files to modify (with line numbers and what to change)
- Implementation approach (step-by-step)
- Risks and edge cases
- Test strategy
- Estimated complexity: simple / medium / complex

AFTER WRITING:
1. mkdir -p .lastlight/issue-${req.issueNumber}
2. Write architect-plan.md
3. Write status.md with current_phase: architect
4. git add .lastlight/ && git commit -m "docs: architect plan for #${req.issueNumber}"
5. git push -u origin HEAD

OUTPUT: The branch name and a brief summary (3-5 lines).`;
}

function buildExecutorPrompt(req: BuildRequest, branch: string): string {
  return `You are the EXECUTOR. Implement precisely what the architect's plan requires.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
2. Read .lastlight/issue-${req.issueNumber}/architect-plan.md

EXECUTION:
- Follow TDD: write failing test first, then implement, then verify
- Run tests and verify they pass

BEFORE COMMITTING — ALL GUARDRAILS MUST PASS:
1. Read .lastlight/issue-${req.issueNumber}/guardrails-report.md to find the exact commands
2. Run the test command and verify ALL tests pass (zero failures)
3. Run the lint command (if present) and fix ALL lint errors
4. Run the typecheck command (if present) and fix ALL type errors
5. If any guardrail fails, fix the issue and re-run until clean
DO NOT commit or claim done until tests, lint, and typecheck all pass.

AFTER ALL GUARDRAILS PASS:
1. Write .lastlight/issue-${req.issueNumber}/executor-summary.md:
   - What was done, files changed
   - Test results (paste actual output)
   - Lint results (paste actual output)
   - Typecheck results (paste actual output)
   - Any deviations from the plan, known issues
2. Update .lastlight/issue-${req.issueNumber}/status.md: current_phase = executor
3. git add -A && git commit -m "feat: implement #${req.issueNumber}

Tested: {test command} -> {result}
Scope-risk: {low|medium|high}"
4. git push origin HEAD

OUTPUT: List of files changed, test/lint/typecheck results, commit hash.`;
}

function buildReviewerPrompt(req: BuildRequest, branch: string): string {
  return `You are the CODE REVIEWER. Independent verification — you have NO shared context with the executor.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}

SCOPE — review ONLY changed files:
  git log --oneline main..HEAD
  git diff main...HEAD --name-only
  git diff main...HEAD

Read .lastlight/issue-${req.issueNumber}/architect-plan.md and executor-summary.md for context.

CHECK:
1. Does implementation match the plan?
2. Do tests pass?
3. Security concerns?
4. Logic errors or missed edge cases?

DO NOT review unchanged files or flag pre-existing issues.

AFTER REVIEW:
1. Write .lastlight/issue-${req.issueNumber}/reviewer-verdict.md (verdict, issues with file:line, test results, suggestions)
2. Update status.md
3. git add .lastlight/ && git commit -m "review: verdict for #${req.issueNumber}" && git push origin HEAD

OUTPUT: Exactly one of APPROVED or REQUEST_CHANGES, followed by a brief summary.`;
}

function buildReReviewPrompt(req: BuildRequest, branch: string, fixCycle: number): string {
  return `You are the CODE REVIEWER — RE-REVIEW after fix cycle ${fixCycle}.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}

This is a FOLLOW-UP review. You previously requested changes. The executor has attempted to fix them.

SCOPE — review ONLY what changed in the fix cycle:
1. Read .lastlight/issue-${req.issueNumber}/reviewer-verdict.md — your previous issues
2. Read the "## Fix Cycle ${fixCycle}" section in .lastlight/issue-${req.issueNumber}/executor-summary.md — what was fixed
3. Diff only the fix commit(s): git log --oneline -3 and git diff HEAD~1

CHECK:
1. Were the specific issues you raised actually addressed?
2. Did the fix introduce any new problems?
3. Do tests still pass?

DO NOT re-review the entire changeset. Only verify your previous issues were fixed.

AFTER REVIEW:
1. APPEND to .lastlight/issue-${req.issueNumber}/reviewer-verdict.md under heading "## Re-review after Fix Cycle ${fixCycle}" (preserve the original verdict above)
2. Update status.md
3. git add .lastlight/ && git commit -m "review: re-review after fix cycle ${fixCycle} for #${req.issueNumber}" && git push origin HEAD

OUTPUT: Exactly one of APPROVED or REQUEST_CHANGES, followed by a brief summary.`;
}

function buildFixPrompt(req: BuildRequest, branch: string, cycle: number): string {
  return `You are the EXECUTOR (fix cycle ${cycle}). Fix ONLY the issues reported by the reviewer.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
2. Read .lastlight/issue-${req.issueNumber}/reviewer-verdict.md — fix ONLY these issues
3. Read .lastlight/issue-${req.issueNumber}/guardrails-report.md for the test/lint/typecheck commands

BEFORE COMMITTING — ALL GUARDRAILS MUST PASS:
1. Run the test command and verify ALL tests pass (zero failures)
2. Run the lint command (if present) and fix ALL lint errors
3. Run the typecheck command (if present) and fix ALL type errors
DO NOT commit until tests, lint, and typecheck all pass.

AFTER ALL GUARDRAILS PASS:
1. APPEND to .lastlight/issue-${req.issueNumber}/executor-summary.md under heading "## Fix Cycle ${cycle}" (what was fixed, test/lint/typecheck results)
2. Update status.md: current_phase = fix_loop_${cycle}
3. git add -A && git commit -m "fix: address review feedback for #${req.issueNumber} (cycle ${cycle})" && git push origin HEAD

OUTPUT: What was fixed, test/lint/typecheck results.`;
}

function buildPrPrompt(req: BuildRequest, branch: string, approved: boolean, fixCycles: number): string {
  const note = approved
    ? ""
    : `\n\nNote: There are unresolved reviewer issues after ${fixCycles} fix cycles. See reviewer-verdict.md on the branch.`;

  return `Create a pull request for the work on branch ${branch}.

Use the MCP tool create_pull_request:
- owner: ${req.owner}
- repo: ${req.repo}
- head: ${branch}
- base: main
- title: A concise title describing the change (reference #${req.issueNumber})
- body: Include:
  - Closes #${req.issueNumber}
  - Summary of changes
  - Link to architect-plan.md and executor-summary.md on the branch
  - Test results${note}

Then use add_issue_comment on issue #${req.issueNumber} to post the PR link.

Update status.md: current_phase = complete, add pr_number.
git add .lastlight/ && git commit -m "status: PR created for #${req.issueNumber}" && git push origin HEAD

OUTPUT: The PR number and URL.`;
}

// ── PR Fix ─────────────────────────────────────────────────────────

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
): Promise<{ success: boolean; output: string }> {
  const notify = callbacks?.postComment || (async () => {});
  const { owner, repo, prNumber, branch } = request;
  const taskId = `${repo}-pr${prNumber}-fix`;

  await notify(`On it — fixing PR #${prNumber}...`);

  const result = await executeAgent(
    buildPrFixPrompt(request),
    config, { taskId }
  );

  if (result.success) {
    await notify(`**Fix pushed** to \`${branch}\`. CI should re-run automatically.`);
  } else if (isTerminated(result.error)) {
    console.log(`[pr-fix] Session terminated — suppressing error comment`);
  } else {
    await notify(`**Fix failed** — I wasn't able to resolve this automatically.`);
  }

  return { success: result.success, output: result.output };
}

function buildPrFixPrompt(req: PrFixRequest): string {
  const ciSection = req.failedChecks && !req.failedChecks.includes("No failed checks")
    ? `\nCI FAILURES (from GitHub Actions — fix these first):\n${req.failedChecks}\n`
    : "";

  return `You are fixing a PR based on a maintainer's request.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${req.branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
2. Read CLAUDE.md and AGENTS.md if they exist

CONTEXT:
- PR #${req.prNumber}: ${req.prTitle}
- Maintainer request: ${req.commentBody}
${ciSection}
INSTRUCTIONS:
1. Understand what the maintainer is asking for${ciSection ? "\n2. The CI failures above are the primary issue — focus on fixing those" : ""}
${ciSection ? "3" : "2"}. Read the relevant code and understand the failure
${ciSection ? "4" : "3"}. Make the fix — keep changes minimal and focused
${ciSection ? "5" : "4"}. Run tests, lint, and typecheck to verify everything passes
${ciSection ? "6" : "5"}. DO NOT commit until all checks pass

AFTER FIXING:
1. git add -A && git commit -m "fix: address feedback on PR #${req.prNumber}

${req.commentBody.slice(0, 100)}"
2. git push origin HEAD

OUTPUT: Brief summary of what was fixed and test results.`;
}
