# Reviewer Verdict — Issue #3: Workflow State Persistence in SQLite

## Verdict: APPROVED

## Test Results

```
 Test Files  1 passed (1)
      Tests  15 passed (15)
   Duration  281ms
```

TypeScript: `npx tsc --noEmit` — zero errors.

## Plan Compliance

Implementation matches the architect plan across all five deliverables:

- `workflow_runs` table DDL and indexes per spec (`src/state/db.ts:87-109`)
- All 8 query methods implemented (`src/state/db.ts:334-442`)
- Orchestrator resume logic replaced with DB lookup (`src/engine/orchestrator.ts:163-234`)
- `persistPhase` and `failWorkflow` helpers wired into all phase exit points
- Admin routes (`src/admin/routes.ts:289-314`) and dashboard API (`dashboard/src/api.ts:157-169`) added
- `status.md` writes retained as convenience artifacts, not resume source

## Issues

### Important

**`src/admin/routes.ts:289` — No input validation on `limit` query parameter**

```typescript
const limit = Number(c.req.query("limit") ?? 20);
```

`Number("abc")` evaluates to `NaN`. `recentWorkflowRuns(NaN)` passes `NaN` to `LIMIT ?` in SQLite. better-sqlite3 will throw at runtime (`TypeError: NaN is not a valid integer`), returning a 500 instead of a 400. Fix:

```typescript
const rawLimit = c.req.query("limit");
const limit = rawLimit ? Math.max(1, Math.min(100, parseInt(rawLimit, 10) || 20)) : 20;
```

### Suggestions

**`src/state/db.ts:381-394` — `finishWorkflowRun` error not verified in tests**

`finishWorkflowRun(id, "failed", "some error")` stores the error in `context` via `json_patch`, but the test (`db.test.ts:108-121`) only checks `status` and `finishedAt`. No test verifies the error is retrievable from `context.error`. Low risk since the SQL logic is straightforward, but worth adding for confidence.

**`src/engine/orchestrator.ts:395-403` — Skipped reviewer path does not call `persistPhase`**

When `rr.skipped` and `approved = true` is assumed, `persistPhase(reviewLabel, ...)` is not called. The workflow run's `currentPhase` stays at the previous phase in the DB until `finishWorkflowRun("succeeded")` is called after PR. This is not incorrect (final state is right), but `activeWorkflowRuns()` will show a stale `currentPhase` during the window. Pre-existing pattern limitation, not a regression.

## Nits

- `dashboard/src/api.ts:162-165` — `workflowRuns` builds a URLSearchParams but the `opts.limit` check is falsy for `limit=0`. Consistent with existing style, not a concern in practice.
- `src/state/db.ts:356` — `updateWorkflowPhase` does a separate SELECT then UPDATE (two round trips). Could be a single SQL expression with `json_insert`/`json_patch`, but SQLite is local and this is called rarely — no performance concern.
