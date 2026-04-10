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
