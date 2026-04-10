# Executor Summary — Issue #6: Loop Nodes as a Workflow Primitive

## What Was Done

Implemented a generic `loop` node type as a workflow primitive, enabling configurable completion conditions (expression-based or bash-based), max iteration caps, optional human gates, and fresh-context resets.

## Files Changed

| File | Change |
|------|--------|
| `src/workflows/schema.ts` | Added `GenericLoopSchema` (with `max_iterations`, `until`, `until_bash`, `interactive`, `gate_message`, `fresh_context`); added `generic_loop` field to `PhaseDefinitionSchema`; exported `GenericLoop` type |
| `src/workflows/loop-eval.ts` | **New file** — minimal expression evaluator supporting `output.contains('text')`, `variable == 'value'`, `variable != 'value'` |
| `src/workflows/loop-eval.test.ts` | **New file** — 14 unit tests for the expression evaluator |
| `src/workflows/templates.ts` | Added `iteration`, `maxIterations`, `previousOutput` to `TemplateContext` |
| `src/workflows/runner.ts` | Added `import { execSync } from "child_process"` and `import { evalUntilExpression }` from loop-eval; updated `phaseIndex()` to map `_iter_` phases to executor position; added full generic loop execution block (~120 lines) after the existing `if (phase.loop)` block |
| `src/workflows/runner.test.ts` | Added `child_process` mock; added 8 new tests in `runWorkflow — generic loop node` describe block |
| `workflows/examples/tdd-loop.yaml` | **New file** — example TDD loop workflow |

## Deviations from Plan

- **Interactive gate**: The plan proposed checking `approvalConfig && db && workflowId`. Removed the `approvalConfig` dependency — generic loop interactive gates are self-contained (not tied to the reviewer gate config). This makes the interactive gate work whenever `db` and `workflowId` are present.
- **Schema validation**: Added a `.refine()` guard requiring at least one of `until` or `until_bash` to be present (plan called this out but listed it under "Step 1" without specifying the mechanism).
- No other deviations.

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  9 passed (9)
      Tests  166 passed (166)
   Start at  10:42:35
   Duration  1.55s (transform 250ms, setup 0ms, import 436ms, tests 170ms, environment 1ms)
```

All 144 pre-existing tests pass unchanged. 22 new tests added (14 in loop-eval.test.ts, 8 in runner.test.ts).

## Lint Results

No linter configured (documented in guardrails-report.md).

## Typecheck Results

```
$ npx tsc --noEmit
(no output — 0 errors)
```

## Known Issues

None.

## Fix Cycle 1

### Issues Fixed

**1. `until_bash` missing `cwd` (`src/workflows/runner.ts:503`)** — Added `cwd: config.sandboxDir ?? config.cwd` to the `execSync` call so the bash condition runs in the sandbox repo directory, not the server's working directory.

**2. `!=` evaluator returns `true` for absent context variables (`src/workflows/loop-eval.ts:42`)** — Added `if (!(key in ctx)) return false;` guard before the inequality check, matching the safe-default behaviour of the `==` evaluator.

**3. Added missing test for absent-variable `!=` edge case (`src/workflows/loop-eval.test.ts`)** — New test: `returns false when variable is absent from context` in the `!=` describe block.

### Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  9 passed (9)
      Tests  167 passed (167)
   Start at  10:47:09
   Duration  1.72s (transform 288ms, setup 0ms, import 497ms, tests 194ms, environment 1ms)
```

167 tests pass (1 new test added for the absent-variable `!=` case).

### Lint Results

No linter configured.

### Typecheck Results

```
$ npx tsc --noEmit
(no output — 0 errors)
```
