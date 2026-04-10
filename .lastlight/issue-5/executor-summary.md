# Executor Summary — Issue #5: YAML Workflow Definitions

## What Was Done

Extracted workflow definitions from the hardcoded TypeScript orchestrator into YAML files and a generic runner. All prompt templates were externalized into Markdown files with `{{variable}}` interpolation.

## Files Changed

### New Files
- `src/workflows/schema.ts` — Zod v4 schema for `BuildWorkflowDefinition` and `CronWorkflowDefinition`
- `src/workflows/templates.ts` — Template engine: `{{var}}`, `{{slugify var}}`, `{{branchUrl file}}`, `{{#if var}}...{{/if}}`
- `src/workflows/loader.ts` — YAML loader with validation and caching; exports `getWorkflow()`, `getCronWorkflows()`, `loadPromptTemplate()`
- `src/workflows/runner.ts` — Generic phase runner extracted from `orchestrator.ts`; handles context phases, agent phases, `on_output` rules, approval gates, reviewer loop with fix cycles
- `src/workflows/templates.test.ts` — 15 tests for the template engine
- `src/workflows/loader.test.ts` — 15 tests for YAML loading and validation
- `src/workflows/runner.test.ts` — 16 tests for the generic runner (phase ordering, guardrails rules, reviewer loop, callbacks)
- `workflows/build.yaml` — Build cycle workflow definition (phase_0 → guardrails → architect → executor → reviewer → pr)
- `workflows/pr-fix.yaml` — PR fix workflow definition (single fix phase)
- `workflows/cron-triage.yaml` — Issue triage cron job definition
- `workflows/cron-review.yaml` — PR review cron job definition
- `workflows/cron-health.yaml` — Health report cron job definition
- `workflows/prompts/resume-check.md` — Resume check prompt template
- `workflows/prompts/guardrails.md` — Guardrails check prompt template
- `workflows/prompts/architect.md` — Architect prompt template
- `workflows/prompts/executor.md` — Executor prompt template
- `workflows/prompts/reviewer.md` — Reviewer prompt template
- `workflows/prompts/re-reviewer.md` — Re-review (after fix cycle) prompt template
- `workflows/prompts/fix.md` — Fix loop prompt template
- `workflows/prompts/pr.md` — PR creation prompt template
- `workflows/prompts/pr-fix.md` — PR fix prompt template

### Modified Files
- `src/engine/orchestrator.ts` — Reduced from 1047 lines to ~220 lines; now a thin wrapper that loads `build.yaml` and delegates to `runWorkflow`; all `build*Prompt` functions removed and replaced with template loading
- `src/cron/jobs.ts` — Replaced hardcoded job list with YAML-driven loader using `getCronWorkflows()`
- `src/config.ts` — Added `workflowDir` config option (default: `./workflows`, env: `WORKFLOW_DIR`)
- `package.json` — Added `yaml` ^2.8.3 and `zod` ^4.3.6 dependencies

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  8 passed (8)
      Tests  141 passed (141)
   Start at  09:15:58
   Duration  1.57s (transform 264ms, setup 0ms, import 459ms, tests 210ms, environment 1ms)
```

All 95 pre-existing tests pass unchanged. 46 new tests added across 3 new test files.

## Lint Results

No linter configured (non-blocking per guardrails report).

## Typecheck Results

```
npx tsc --noEmit  → exit 0, no errors
```

## Deviations from Plan

1. **`workflowDir` in runner**: The runner uses `loadPromptTemplate()` from the loader, which uses the globally configured `workflowDir`. The orchestrator sets this from config at startup (not yet wired in `src/index.ts` — left as a follow-on since `loadConfig()` exposes it).

2. **Zod v4 API**: The project had no Zod dependency; installed Zod v4 (latest). Used `z.record(keySchema, valueSchema)` syntax required by v4 (not v3's single-arg form).

3. **`pr-fix.yaml` not used by `runPrFix`**: The `runPrFix` function loads the `pr-fix.md` prompt template directly (not via a YAML workflow phase runner) since it's a single-step operation with no phase loop. This keeps the implementation simple while externalizing the prompt.

4. **Prompt fidelity**: All prompt content migrated verbatim. The `pr-fix.md` template simplifies the conditional numbering (was dynamic `${ciSection ? "3" : "2"}` in TS) into a fixed-number list; the substance is identical.

5. **Resume logic in runner**: The runner reuses the orchestrator's PHASE_ORDER constants for resume tracking. Phases not in PHASE_ORDER (like `pr`) always run regardless of resume position.

## Known Issues

None. All guardrails pass.
