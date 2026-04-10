## Executor Summary — Issue #7: DAG Parallelism

### Changes Made

**New files:**
- `src/workflows/dag.ts` — Core DAG primitives: `buildDag`, `evaluateTriggerRule`, `getReadyNodes`, `getNodesToSkip`, `isComplete`, `topoSort`
- `src/workflows/dag.test.ts` — 34 unit tests covering all DAG functions
- `workflows/examples/parallel-review.yaml` — Example workflow demonstrating parallel architect+security-review → executor → pr

**Modified files:**
- `src/workflows/schema.ts` — Added `depends_on`, `trigger_rule`, `output_var` to `PhaseDefinitionSchema`
- `src/workflows/templates.ts` — Added `phaseOutputs` to `TemplateContext`; added step 0 in `renderTemplate` for `${phaseName.output}` substitution
- `src/state/db.ts` — Added `nodeStatuses` to `WorkflowRun`; added `ALTER TABLE` migration; added `updateNodeStatus` method
- `src/workflows/runner.ts` — Added DAG imports, `hasDependencies` helper, `DagRunnerCtx` interface, `runDagWorkflow` function, and branch in `runWorkflow`
- `src/workflows/runner.test.ts` — Added 7 DAG integration tests

### Implementation Notes

- The sequential execution path is untouched — `hasDependencies()` gates the DAG path only when `depends_on` is declared on any phase
- `trigger_rule` is `.optional()` (not `.default()`) in Zod to keep `BuildWorkflowDefinition` assignable from literal object types in tests; the default `"all_success"` is applied in `buildDag`
- Concurrent dispatch uses `Promise.allSettled` — all ready nodes in a DAG round run in parallel
- Loop phases (`loop`, `generic_loop`) are supported inside DAG workflows via the same logic as sequential, running as a single DAG node
- `output_var` support: phase output stored in `outputs` map and injected as `phaseOutputs` context for downstream `${name.output}` substitution

### Test Results

- 201 tests pass (34 new: 34 in dag.test.ts + 7 in runner.test.ts)
- `npx tsc --noEmit` clean

## Fix Cycle 1

### Issues Fixed

**Important — rejected promise leaves node stuck in "running" (`runner.ts`)**
Wrapped the entire `nodePromises` map callback body in a `try/catch`. Previously, if `executeAgent` (or any other call) threw unexpectedly, `Promise.allSettled` returned a rejected item with no node reference, and the handler just logged and `continue`d — leaving the node in `"running"` state, silently abandoning downstream phases, and potentially reporting `success: true` despite the crash.

Fix: the inner `try` catches any exception, logs it, and returns `{ node, result: PhaseResult(success=false), paused: false, alreadyPushed: false }`. The settled-loop then marks `node.status = "failed"` and pushes the error result to `phases[]`, so downstream trigger rules evaluate correctly and overall success reflects the crash.

**Suggestion — context-phase results missing from `phases[]` in DAG path (`runner.ts`)**
Changed context-phase return from `alreadyPushed: true` to `alreadyPushed: false`. The settled loop now pushes the context `PhaseResult` to `phases[]`, matching the sequential path's behavior.

**Suggestion — no test for the throw/reject path (`runner.test.ts`)**
Added test: "unexpected throw in executeAgent marks phase failed and overall success=false". Mocks `executeAgent` to reject on `executor_a`, then asserts overall `success=false`, the failed phase appears in `phases[]` with `success=false`, and downstream `merge` is skipped.

**Nit — DFS traversal direction comment (`dag.ts`)**
Added a three-line comment above the `dfs` function explaining that it follows `depends_on` edges (child→parent) and why cycle detection still works.

**Nit — paused-node comment (`runner.ts`)**
Expanded the inline comment on `node.status = "succeeded"` to explain that treating paused as succeeded ensures downstream trigger rules fire correctly after approval.

### Test Results

- 202 tests pass (201 existing + 1 new for throw path)
- `npx tsc --noEmit` clean (no type errors)
- No linter configured
