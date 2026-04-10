# Reviewer Verdict — Issue #7

VERDICT: REQUEST_CHANGES

## Summary

The DAG scheduler module (`dag.ts`) is clean, well-tested, and algorithmically correct. Schema and DB changes are additive and backward-compatible. The runner integration is mostly sound, but there is one important bug in the rejected-promise handling path that causes silent failure: downstream phases are abandoned without any error record, and the workflow can report incorrect overall success. There is also a minor inconsistency where context-phase results are not recorded in `phases` in the DAG path, diverging from the sequential path's behavior.

## Issues

### Critical
None.

### Important

**Rejected promise leaves node stuck in "running", silently abandons downstream phases**
`src/workflows/runner.ts:1051–1053`

When a node's promise rejects (an unexpected exception, not a normal phase failure), the handler logs and `continue`s without transitioning `node.status` away from `"running"`. On the next loop iteration:
- `getNodesToSkip()` and `getReadyNodes()` both filter for `"pending"` nodes whose deps are all terminal. The stuck `"running"` node is non-terminal, so its downstream dependents remain `"pending"` with non-terminal deps — neither function returns them.
- `ready.length === 0` and `toSkip.length === 0` → the `break` on line 898 fires.
- The workflow exits with only the phases that completed, while downstream phases are silently dropped. Because those dropped phases are never pushed to `phases[]`, `phases.some((p) => !p.success)` may return `false`, causing the workflow to report `success: true` despite a crash.

Fix: when `settledItem.status === "rejected"`, mark the node as `"failed"` and push an error `PhaseResult` so downstream trigger rules fire and overall success reflects the crash.

```typescript
// src/workflows/runner.ts — in the settled loop
if (settledItem.status === "rejected") {
  console.error("[dag] Phase promise rejected:", settledItem.reason);
  // Find which node this corresponds to — need node reference in the rejection
  // Simplest fix: wrap nodePromises to always resolve with a rejection sentinel
  continue; // current code — replace with node.status = "failed"
}
```

Because the rejected promise carries no `node` reference at catch time, the cleanest fix is to wrap each nodePromise so it never rejects:

```typescript
const nodePromises = ready.map(async (node) => {
  try {
    // ... existing logic ...
  } catch (err) {
    console.error(`[dag] Phase "${node.name}" threw unexpectedly:`, err);
    const result: PhaseResult = { phase: node.name, success: false, error: String(err), output: "" };
    return { node, result, paused: false, alreadyPushed: false };
  }
});
```

This ensures the node is always marked `"failed"`, downstream trigger rules evaluate correctly, and the overall success flag is accurate.

### Suggestions

**Context-phase results not pushed to `phases` in DAG path**
`src/workflows/runner.ts:916–919`

The DAG path returns `alreadyPushed: true` for context phases without ever pushing to `phases`, while the sequential path (line 241) does push them. This means `WorkflowResult.phases` is missing context-phase entries when running via DAG. Not execution-breaking, but creates an inconsistency in the result shape that callers may rely on.

Fix: either push before returning `alreadyPushed: true`, or change to `alreadyPushed: false` and let the settled loop push it (node.status is still updated correctly either way).

**No test for the rejected-promise path**
`src/workflows/runner.test.ts`

There is no test covering the scenario where `executeAgent` throws (as opposed to resolving with a failure result). This is the path that triggers the bug above. A test that mocks `executeAgent` to throw should be added.

### Nits

- `dag.ts:612` — DFS traverses in the direction of `depends_on` edges (child → parent), which reverses the conventional DAG direction. The cycle detection still works correctly because a GRAY ancestor reachable from a descendant does indicate a cycle in this representation. Consider a comment noting this traversal direction to prevent future confusion.
- `runner.ts:1062–1065` — Treating a paused node as `"succeeded"` for DAG purposes is correct for the approval-gate use case, but a comment explaining why would aid future maintainers.

## Test Results

```
> lastlight@2.0.0 test
> vitest run

 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  10 passed (10)
      Tests  201 passed (201)
   Start at  14:06:49
   Duration  2.14s (transform 416ms, setup 0ms, import 671ms, tests 243ms, environment 1ms)
```

## Re-review after Fix Cycle 1

VERDICT: APPROVED

All five issues from the initial review are addressed. The important bug (rejected promise leaving a node stuck in `"running"` with silent downstream abandonment) is fixed: the entire `nodePromise` lambda body is wrapped in a `try/catch` that catches unexpected throws, constructs a `PhaseResult` with `success: false`, and returns it so the settled loop correctly sets `node.status = "failed"`, pushes the error result to `phases[]`, and triggers `db.updateNodeStatus`. The context-phase `alreadyPushed` fix is correct — changing to `false` lets the settled loop push context results to `phases[]`, matching sequential-path behavior. The new test (`"unexpected throw in executeAgent marks phase failed and overall success=false"`) exercises the throw path end-to-end and asserts all three required properties. Both nit comments were added. All 202 tests pass; `tsc --noEmit` is clean. One minor gap: `onEnd` is not called in the catch block, so callers using `onPhaseEnd` won't receive notification for unexpected-throw failures — but this is a notification gap only (data correctness is unaffected), was not in the original review, and does not warrant blocking merge.
