import type { ExecutorConfig, ExecutionResult } from "./executor.js";
import { executeAgent } from "./executor.js";

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

export async function runBuildCycle(
  request: BuildRequest,
  config: ExecutorConfig,
  callbacks?: {
    onPhaseStart?: (phase: string) => Promise<void>;
    onPhaseEnd?: (phase: string, result: PhaseResult) => Promise<void>;
    postComment?: (body: string) => Promise<void>;
  }
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

  // ── Guardrails Check ──────────────────────────────────────────

  if (shouldRun("guardrails")) {
    await onStart("guardrails");
    console.log(`[orchestrator] Guardrails check for ${owner}/${repo}`);

    const guardrailsResult = await executeAgent(
      buildGuardrailsPrompt(request, branch),
      config, { taskId: `${taskId}-guardrails` }
    );

    phases.push({ phase: "guardrails", ...pick(guardrailsResult) });
    await onEnd("guardrails", phases[phases.length - 1]);

    const guardrailsOutput = guardrailsResult.output?.toUpperCase() || "";
    if (guardrailsOutput.includes("BLOCKED")) {
      await notify(
        `**Guardrails check: BLOCKED** — missing foundational tooling (tests, linting, or type checking).\n\n` +
        `A separate issue has been created to add the missing guardrails. ` +
        `Implementation will proceed once foundations are in place.\n\n` +
        `See the guardrails report on branch \`${branch}\` at \`.lastlight/issue-${issueNumber}/guardrails-report.md\``
      );
      return { success: false, phases };
    }

    if (guardrailsResult.success) {
      await notify(`**Guardrails check: READY** — test framework, linting, and type checking verified. Starting architect analysis...`);
    } else {
      await notify(`**Guardrails check completed with warnings.** Proceeding to architect analysis...`);
    }
  }

  // ── Phase 1: Architect ─────────────────────────────────────────

  if (shouldRun("architect")) {
    await onStart("architect");
    console.log(`[orchestrator] Phase 1: Architect analysis`);

    const architectResult = await executeAgent(
      buildArchitectPrompt(request, branch, contextSnapshot),
      config, { taskId: `${taskId}-architect` }
    );

    phases.push({ phase: "architect", ...pick(architectResult) });
    await onEnd("architect", phases[phases.length - 1]);

    if (!architectResult.success) {
      await notify(`Architect analysis failed: ${architectResult.error}`);
      return { success: false, phases };
    }

    await notify(
      `**Architect analysis complete.**\n` +
      `- Branch: \`${branch}\`\n` +
      `- Plan: \`.lastlight/issue-${issueNumber}/architect-plan.md\`\n\n` +
      `Starting implementation...`
    );
  }

  // ── Phase 2: Executor ──────────────────────────────────────────

  if (shouldRun("executor")) {
    await onStart("executor");
    console.log(`[orchestrator] Phase 2: Executor implementation`);

    const executorResult = await executeAgent(
      buildExecutorPrompt(request, branch),
      config, { taskId: `${taskId}-executor` }
    );

    phases.push({ phase: "executor", ...pick(executorResult) });
    await onEnd("executor", phases[phases.length - 1]);

    if (!executorResult.success) {
      await notify(`Executor implementation failed: ${executorResult.error}`);
      return { success: false, phases };
    }

    await notify(
      `**Implementation complete.** Running independent review...\n` +
      `- Branch: \`${branch}\`\n` +
      `- Summary: \`.lastlight/issue-${issueNumber}/executor-summary.md\``
    );
  }

  // ── Phase 3: Reviewer + Fix Loop ───────────────────────────────

  let approved = false;
  let fixCycles = 0;
  const MAX_FIX_CYCLES = 2;

    while (!approved && fixCycles <= MAX_FIX_CYCLES) {
      const reviewLabel = fixCycles === 0 ? "reviewer" : `reviewer_${fixCycles + 1}`;
      await onStart(reviewLabel);
      console.log(`[orchestrator] Phase 3: Reviewer (cycle ${fixCycles + 1})`);

      const reviewerResult = await executeAgent(
        buildReviewerPrompt(request, branch),
        config, { taskId: `${taskId}-${reviewLabel}` }
      );

      phases.push({ phase: reviewLabel, ...pick(reviewerResult) });
      await onEnd(reviewLabel, phases[phases.length - 1]);

      const verdict = reviewerResult.output?.toUpperCase() || "";
      if (verdict.includes("APPROVED")) {
        approved = true;
        await notify(`**Review: APPROVED** — proceeding to PR.`);
      } else if (fixCycles < MAX_FIX_CYCLES) {
        fixCycles++;
        await notify(`**Review: REQUEST_CHANGES** — fixing issues (cycle ${fixCycles}/${MAX_FIX_CYCLES})...`);

        await onStart(`fix_loop_${fixCycles}`);
        console.log(`[orchestrator] Phase 4: Fix loop (cycle ${fixCycles})`);

        const fixResult = await executeAgent(
          buildFixPrompt(request, branch, fixCycles),
          config, { taskId: `${taskId}-fix${fixCycles}` }
        );

        phases.push({ phase: `fix_loop_${fixCycles}`, ...pick(fixResult) });
        await onEnd(`fix_loop_${fixCycles}`, phases[phases.length - 1]);

        if (!fixResult.success) {
          await notify(`Fix cycle ${fixCycles} failed. Proceeding to PR with known issues.`);
          break;
        }
      } else {
        await notify(`**Review: REQUEST_CHANGES** after ${MAX_FIX_CYCLES} fix cycles. Proceeding with remaining issues noted.`);
        break;
      }
    }

    // ── Phase 5: Create PR ─────────────────────────────────────────

    await onStart("pr");
    console.log(`[orchestrator] Phase 5: Create PR`);

    const prResult = await executeAgent(
      buildPrPrompt(request, branch, approved, fixCycles),
      config, { taskId: `${taskId}-pr` }
    );

    phases.push({ phase: "pr", ...pick(prResult) });
    await onEnd("pr", phases[phases.length - 1]);

    const prMatch = prResult.output?.match(/#(\d+)/);
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : undefined;

    if (prNumber) {
      await notify(`**PR created:** #${prNumber}\n\nBuild cycle complete.`);
    }

    return { success: prResult.success, phases, prNumber };
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

AFTER IMPLEMENTATION:
1. Write .lastlight/issue-${req.issueNumber}/executor-summary.md (what was done, files changed, test results, deviations, known issues)
2. Update .lastlight/issue-${req.issueNumber}/status.md: current_phase = executor
3. git add -A && git commit -m "feat: implement #${req.issueNumber}

Tested: {test command} -> {result}
Scope-risk: {low|medium|high}"
4. git push origin HEAD

OUTPUT: List of files changed, test results, commit hash.`;
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

function buildFixPrompt(req: BuildRequest, branch: string, cycle: number): string {
  return `You are the EXECUTOR (fix cycle ${cycle}). Fix ONLY the issues reported by the reviewer.

SETUP (git is pre-configured, you are in a sandbox workspace):
1. git clone --branch ${branch} https://github.com/${req.owner}/${req.repo}.git && cd ${req.repo}
2. Read .lastlight/issue-${req.issueNumber}/reviewer-verdict.md — fix ONLY these issues

AFTER FIXING:
1. APPEND to .lastlight/issue-${req.issueNumber}/executor-summary.md under heading "## Fix Cycle ${cycle}"
2. Update status.md: current_phase = fix_loop_${cycle}
3. git add -A && git commit -m "fix: address review feedback for #${req.issueNumber} (cycle ${cycle})" && git push origin HEAD

OUTPUT: What was fixed, test results.`;
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
