# Architect Plan — Issue #7: DAG Parallelism in Workflow Executor

## Problem Statement

The workflow runner (`src/workflows/runner.ts:221`) executes all phases in strict sequential order via a `for...of` loop over `definition.phases`. There is no mechanism to declare dependencies between phases or run independent phases concurrently. The issue requests DAG-based parallelism so that independent phases (e.g., parallel reviewers, parallel guardrail checks) can execute via `Promise.allSettled`, with `depends_on` edges and `trigger_rule` conditions controlling downstream execution. The current schema (`src/workflows/schema.ts:50-72`) has no `depends_on`, `trigger_rule`, or output variable fields.

## Summary of Changes

1. **Extend the workflow schema** to support `depends_on`, `trigger_rule`, and `output_var` on phase definitions
2. **Add a DAG scheduler** that performs topological sort and groups phases into parallelizable layers
3. **Modify the runner** to use DAG-based execution when `depends_on` edges are present, falling back to sequential for legacy workflows
4. **Add output variable substitution** so downstream phases can reference `${phase_name.output}` in prompts
5. **Track per-node status** in workflow run state for parallel phase tracking
6. **Update tests** to cover DAG execution, trigger rules, and output substitution

## Files to Modify

### 1. `src/workflows/schema.ts` — Add DAG fields to PhaseDefinitionSchema

**Lines 50-72** (PhaseDefinitionSchema): Add three new optional fields:

```typescript
depends_on: z.array(z.string()).optional(),
trigger_rule: z.enum(["all_success", "one_success", "none_failed_min_one_success", "all_done"]).default("all_success"),
output_var: z.string().optional(),
```

- `depends_on`: Array of phase names that must complete before this phase starts
- `trigger_rule`: Condition evaluated against dependency results (default: `all_success`)
- `output_var`: Optional name to expose this phase's output for downstream `${name.output}` substitution

### 2. `src/workflows/dag.ts` — New file: DAG scheduler

Create a standalone, pure-function module (~150 lines):

- **`type NodeStatus`**: `"pending" | "running" | "succeeded" | "failed" | "skipped"`
- **`interface DagNode`**: `{ name, depends_on, trigger_rule, status, output? }`
- **`buildDag(phases: PhaseDefinition[]): DagNode[]`** — Validate edges (no missing deps, no self-deps), detect cycles via DFS
- **`getReadyNodes(dag: DagNode[]): DagNode[]`** — Return nodes whose dependencies are all resolved and whose `trigger_rule` is satisfied
- **`evaluateTriggerRule(rule, depStatuses): boolean`** — Pure function implementing the four trigger rules:
  - `all_success`: every dep succeeded
  - `one_success`: at least one dep succeeded
  - `none_failed_min_one_success`: no dep failed AND at least one succeeded
  - `all_done`: all deps are in a terminal state (succeeded, failed, or skipped)
- **`isComplete(dag): boolean`** — All nodes are in a terminal state
- **`topoSort(dag): string[][]`** — Return layers (groups of parallelizable phase names) for logging/debugging

### 3. `src/workflows/runner.ts` — Integrate DAG execution

**Lines 219-729** (the `for (const phase of definition.phases)` block): Wrap in a branch:

```
if (hasDependencies(definition)) {
  return runDagWorkflow(...)   // new function
} else {
  // existing sequential loop (unchanged)
}
```

**New function `runDagWorkflow()`** (~120 lines):

1. Call `buildDag(definition.phases)` to create the DAG
2. Main loop: while `!isComplete(dag)`:
   a. `getReadyNodes(dag)` to find executable phases
   b. For each ready node, mark as `"running"`, dispatch via existing phase execution logic
   c. Use `Promise.allSettled()` to run all ready nodes concurrently
   d. On completion, update node status (`"succeeded"` or `"failed"`)
   e. Evaluate trigger rules for downstream nodes — mark as `"skipped"` if rule fails
3. Collect results into `PhaseResult[]` in completion order
4. Handle approval gates: if a parallel node hits a gate, pause the entire workflow (same as current behavior)

**Key design decisions:**
- Each parallel phase gets its own `taskId` suffix (already the pattern: `${taskId}-${phaseName}`)
- Context object (`ctx`) is **read-only during parallel execution** — parallel phases cannot mutate shared context. Each phase receives a frozen snapshot. Post-phase context mutations (lines 412-414, 555-557) are applied sequentially after the parallel layer completes.
- Loop phases (`phase.loop` and `phase.generic_loop`) execute within the DAG as single logical nodes — their internal iterations remain sequential

**Output variable substitution** (~20 lines):
- After each phase completes, if it has `output_var`, store `{ [output_var]: result.output }` in an `outputs` map
- Before rendering a prompt, scan for `${name.output}` patterns and substitute from the outputs map
- Add this to `renderPrompt()` or as a pre-render step

### 4. `src/workflows/templates.ts` — Output variable resolution

**Lines 11-54** (TemplateContext): Add optional field:

```typescript
phaseOutputs?: Record<string, string>;
```

**Line ~103-117** (variable substitution in `renderTemplate`): Add a pass that replaces `${phase_name.output}` patterns before standard `{{var}}` substitution. Use a distinct syntax (`${}` vs `{{}}`) to avoid ambiguity with existing template vars.

### 5. `src/state/db.ts` — Per-node status tracking

**Lines 26-39** (WorkflowRun interface): Add optional field:

```typescript
nodeStatuses?: Record<string, "pending" | "running" | "succeeded" | "failed" | "skipped">;
```

**Migration** (line 70+): Add `node_statuses TEXT` column to `workflow_runs` table (JSON blob, nullable for backward compat).

**New method**: `updateNodeStatus(workflowId, nodeName, status)` — updates the JSON field.

### 6. `src/workflows/runner.test.ts` — New test suites

Add test suites (~200 lines):

- **DAG scheduling tests** (unit tests for `dag.ts`):
  - Topological sort correctness
  - Cycle detection throws error
  - Missing dependency detection
  - Layer grouping (independent nodes in same layer)
  - All four trigger rules with various dependency outcomes

- **DAG workflow execution tests** (integration with mocked executor):
  - Two independent phases run in parallel (verify `Promise.allSettled` behavior)
  - Diamond dependency: A -> B,C -> D (B and C parallel, D waits for both)
  - Trigger rule `all_done`: downstream runs even when upstream fails
  - Trigger rule `all_success`: downstream skipped when upstream fails
  - Output variable substitution in downstream prompts
  - Approval gate in a DAG node pauses entire workflow
  - Loop phase as a DAG node (sequential internally, participates in DAG externally)

- **Backward compatibility test**:
  - Existing sequential workflow (no `depends_on`) runs identically to current behavior

## Implementation Approach

### Step 1: Schema extension (`schema.ts`)
Add `depends_on`, `trigger_rule`, `output_var` to `PhaseDefinitionSchema`. Non-breaking — all fields are optional with sensible defaults.

### Step 2: DAG scheduler (`dag.ts`)
Build as a standalone pure-function module. No dependencies on runner, executor, or DB. Fully unit-testable in isolation.

### Step 3: DAG tests (`dag.test.ts`)
Write comprehensive tests for the scheduler before integrating. This is the core correctness guarantee.

### Step 4: Output variable substitution (`templates.ts`)
Add `${name.output}` resolution. Test with existing template tests.

### Step 5: Runner integration (`runner.ts`)
Add `runDagWorkflow()` alongside existing sequential loop. Feature detection via `hasDependencies()` — if no phase uses `depends_on`, the sequential path runs (zero risk to existing workflows).

### Step 6: Runner integration tests (`runner.test.ts`)
Test DAG execution end-to-end with mocked executor.

### Step 7: DB migration (`db.ts`)
Add `node_statuses` column. Nullable, backward compatible.

### Step 8: Example workflow (`workflows/examples/`)
Add `parallel-review.yaml` demonstrating parallel reviewers merging into a synthesis node.

## Risks and Edge Cases

1. **Context mutation during parallel execution**: Phases currently mutate `ctx` in-place (runner.ts:413-414, 556-557). Parallel phases must receive immutable snapshots. Mitigation: freeze context before parallel dispatch, merge results after layer completes.

2. **Approval gates in parallel layers**: If one parallel node triggers an approval gate, the entire workflow pauses. Other parallel nodes already running must complete (they're in-flight). On resume, only the gated node's downstream continues. This needs careful state tracking.

3. **Loop phases in DAG**: A reviewer loop or generic loop is inherently sequential internally. It participates in the DAG as a single node — it blocks downstream nodes until the entire loop completes. This is correct behavior but could be surprising.

4. **Error propagation with `all_done`**: A merge node using `trigger_rule: all_done` will run even if all upstreams failed. The merge prompt must handle empty/error outputs gracefully. Mitigation: document this clearly, provide `${node.status}` variable alongside `${node.output}`.

5. **Container resource limits**: Running N phases in parallel means N concurrent Docker containers. No immediate mitigation needed (the sandbox environment handles this), but workflows should be reasonable (2-5 parallel nodes, not 50).

6. **DB deduplication with parallel phases**: `shouldRunPhase()` (runner.ts:85) uses `skill + triggerId` as the key. Parallel phases have distinct skill names, so deduplication works correctly. No change needed.

7. **Resume after crash during parallel execution**: If the runner crashes mid-layer, some nodes may be "running" in the DB but their containers are dead. The existing stale-cleanup logic (runner.ts:93-94) handles this — `markStaleAsFailed` clears dead entries. On resume, completed nodes are skipped, failed nodes re-run based on their trigger rules.

8. **Backward compatibility**: Critical. The `hasDependencies()` check ensures existing workflows (`build.yaml`, `pr-fix.yaml`, `tdd-loop.yaml`) use the current sequential path with zero changes. Only workflows that explicitly declare `depends_on` edges enter the DAG path.

## Test Strategy

- **Unit tests for `dag.ts`**: Pure functions, no mocks needed. Test topological sort, cycle detection, trigger rule evaluation, ready-node selection. ~15 test cases.
- **Integration tests for DAG runner**: Mock `executeAgent` (same pattern as existing tests). Verify parallel dispatch via timing/call-order assertions and `Promise.allSettled` behavior. ~10 test cases.
- **Regression tests**: Run all 167 existing tests to ensure sequential path is unaffected.
- **Type checking**: `npx tsc --noEmit` must pass with new types.

## Estimated Complexity

**Medium-complex**

- New standalone module (`dag.ts`) is algorithmically straightforward (topological sort + trigger rules)
- Runner integration is the riskiest part — parallel dispatch with context isolation and approval gate handling
- Schema and DB changes are additive and non-breaking
- ~500-700 lines of new code across all files, ~200 lines of new tests
