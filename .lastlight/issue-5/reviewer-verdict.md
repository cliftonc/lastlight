# Reviewer Verdict — Issue #5

VERDICT: REQUEST_CHANGES

## Summary

The YAML workflow extraction is architecturally sound and all 141 tests pass with clean type-checking. However two behavioral regressions were introduced in the refactor: the no-DB resume path silently lost mid-cycle resume capability, and the `pr-fix.md` template dropped the CI-specific instruction ("The CI failures above are the primary issue — fix those first") that was present in the original `buildPrFixPrompt`. Additionally, after gate approval the orchestrator computes a `resumeFrom` local variable that is never passed to the runner, relying on implicit DB dedup to handle phase skipping — this is fragile coupling worth fixing before merge.

## Issues

### Critical

None.

### Important

**1. No-DB resume regression** — `src/engine/orchestrator.ts:169-180`

The original `buildBuildCycle` no-DB path parsed `current_phase:` from the resume-check agent output and set `resumeFrom` to skip already-done phases. The new code (lines 169-180) only checks for `current_phase: complete` and discards all other phase markers. Without a DB, the runner always starts from `phase_0`, re-running guardrails and architect unnecessarily (they will re-execute and re-commit). This is a regression for the no-DB deployment mode.

Original behavior:
```ts
const phaseMatch = output.match(/current_phase:\s*(\S+)/);
if (phaseMatch) {
  const completedPhase = phaseMatch[1];
  const completedIdx = phaseIndex(completedPhase);
  if (completedIdx >= 0 && completedIdx < PHASE_ORDER.length - 1) {
    resumeFrom = PHASE_ORDER[completedIdx + 1];
    // ... notify + continue
  }
}
```
This block was dropped. The runner has no mechanism to receive the agent-derived `resumeFrom` even if the orchestrator computed it.

**2. Post-gate approval resume relies on implicit phase dedup** — `src/engine/orchestrator.ts:107-111`, `src/workflows/runner.ts:190-206`

After a `post_architect` or `post_reviewer` gate is approved, `db.resumeWorkflowRun` only changes `status` to `"running"` — it does not update `currentPhase`. The runner's `getWorkflowRun` then sees `currentPhase = "waiting_approval"`, which maps to `phaseIndex = -1`, so `resumeFrom` stays `"phase_0"`. The runner falls back to per-phase DB dedup (`shouldRunPhase`) to skip already-done phases. This is functional but fragile: it requires every phase that ran before the gate to have a successful `executions` row, and the `phase_0` context phase always re-runs (harmlessly). A clean fix would be: when resuming from an approved gate, `db.updateWorkflowPhase(workflowId, gatePhase, ...)` so the runner's `currentPhase` reflects the last completed phase before the gate.

### Suggestions

**3. `pr-fix.md` prompt regression** — `workflows/prompts/pr-fix.md:11-14`

The original `buildPrFixPrompt` included a CI-specific instruction when `ciSection` was non-empty:
```
2. The CI failures above are the primary issue — focus on fixing those
```
and dynamically renumbered subsequent steps. The new template always uses fixed numbering 1-5 and omits the CI-priority instruction. The CI content is still injected via `{{ciSection}}`, but the agent is no longer told to prioritize it. Add a `{{#if ciSection}}` conditional instruction block:

```md
{{#if ciSection}}
2. The CI failures above are the primary issue — focus on fixing those first
3. Read the relevant code and understand the failure
{{/if}}
{{#if ciSection}}4.{{else}}2.{{/if}} Make the fix...
```

Or use a simpler approach: add a conditional line before INSTRUCTIONS rather than renumbering.

**4. Runner tests don't cover approval gate pause/resume** — `src/workflows/runner.test.ts`

There are 16 runner tests covering the main happy paths, guardrails BLOCKED, and the reviewer loop. There are no tests for `approval_gate` pausing or resuming — this is the highest-risk code path given issues #1 and #2 above. Tests should verify: (a) runner returns `paused: true` when gate is configured, (b) runner resumes correctly from the right phase after gate approval.

### Nits

**5. Dead local variables in orchestrator** — `src/engine/orchestrator.ts:76-83`

`PHASE_ORDER`, the `Phase` type alias, and `phaseIndex()` are declared in the no-DB path but `PHASE_ORDER` and `phaseIndex` are used in the DB branch and the no-DB branch similarly. With the no-DB phase-match block removed (see #1), `phaseIndex` is only called from `completedIdx` in the DB path (lines 128, 196). The duplicate definitions in orchestrator vs. runner are redundant — if the orchestrator ever needs `resumeFrom` (to pass to the runner), these should become shared imports.

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  8 passed (8)
      Tests  141 passed (141)
   Start at  09:19:16
   Duration  1.42s (transform 229ms, setup 0ms, import 401ms, tests 177ms, environment 1ms)
```

Type check: `npx tsc --noEmit` → exit 0, no errors.
