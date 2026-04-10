# Architect Plan — Issue #3: Workflow State Persistence in SQLite

## Problem Statement

Workflow state for the build cycle is split between two systems: the SQLite `executions` table (`src/state/db.ts:36-49`) tracks per-phase execution records (running/done/failed) as flat rows, while `status.md` on the git branch tracks the current phase and resume point. The orchestrator's resume logic (`src/engine/orchestrator.ts:160-191`) clones the branch and parses `status.md` to determine where to resume — this is fragile because the agent must follow prompt instructions to write the file, and if it crashes mid-write, state is lost. The issue requests a new `workflow_runs` table that becomes the authoritative source of truth for workflow state, with `status.md` retained as a convenience artifact.

## Summary of Changes

1. **New `workflow_runs` table** in `src/state/db.ts` with structured workflow state, phase history, and JSON context
2. **New query methods** on `StateDb` for creating, updating, querying, and listing workflow runs
3. **Refactored orchestrator** in `src/engine/orchestrator.ts` to read/write workflow state from DB instead of parsing `status.md` from git
4. **New admin API endpoint** in `src/admin/routes.ts` to expose workflow runs
5. **New dashboard API method** in `dashboard/src/api.ts` to fetch workflow runs
6. **Test infrastructure** — vitest setup + tests for new DB methods and orchestrator state transitions

## Files to Modify

### 1. `src/state/db.ts` (307 lines)

- **Lines 34-68 (`migrate()`)**: Add `workflow_runs` table DDL and indexes after existing tables
- **After line 296**: Add new methods:
  - `createWorkflowRun(run)` — insert new workflow run
  - `updateWorkflowPhase(id, phase, phaseEntry)` — update `current_phase`, append to `phase_history` JSON, set `updated_at`
  - `finishWorkflowRun(id, status, error?)` — set `status`, `finished_at`
  - `getWorkflowRun(id)` — get by primary key
  - `getWorkflowRunByTrigger(triggerId)` — find active/latest run for a trigger
  - `activeWorkflowRuns()` — list all running/paused workflows
  - `recentWorkflowRuns(limit)` — paginated list for dashboard
  - `cancelWorkflowRun(id)` — set status to `cancelled`
- **New interface** `WorkflowRun` and `PhaseHistoryEntry` types (before or after `ExecutionRecord` interface at line 6)

### 2. `src/engine/orchestrator.ts` (737 lines)

- **Lines 137-191 (resume logic)**: Replace the agent-based resume check with a DB lookup:
  - Remove `executeAgent(buildResumeCheckPrompt(...))` call (lines 164-167)
  - Instead call `db.getWorkflowRunByTrigger(triggerId)` to find existing run
  - If run exists and status is `running` or `paused`, resume from `current_phase`
  - If run exists and status is `succeeded`, return immediately
  - If no run exists, create one with `db.createWorkflowRun()`
- **Lines 205-249 (guardrails phase)**: After `runPhase()` completes, call `db.updateWorkflowPhase()` to persist phase transition
- **Lines 253-282 (architect phase)**: Same — update workflow phase on completion
- **Lines 286-316 (executor phase)**: Same
- **Lines 320-383 (reviewer + fix loop)**: Same — update phase for each review/fix cycle
- **Lines 387-412 (PR phase)**: Call `db.finishWorkflowRun(id, "succeeded")` on success
- **Error paths throughout**: Call `db.finishWorkflowRun(id, "failed", error)` on failure
- **Lines 427-439 (`buildResumeCheckPrompt`)**: Keep function but it becomes a fallback — primary resume is DB-driven
- **Context storage**: Store branch name, model overrides in the workflow run's `context` JSON

### 3. `src/admin/routes.ts` (290 lines)

- **After line 287 (before `return app`)**: Add new endpoints:
  - `GET /workflow-runs` — list recent workflow runs with pagination
  - `GET /workflow-runs/:id` — get single workflow run with phase history
  - `POST /workflow-runs/:id/cancel` — cancel a running workflow

### 4. `dashboard/src/api.ts` (139 lines)

- **After line 133 (inside `api` object)**: Add:
  - `workflowRuns(opts)` — fetch workflow run list
  - `workflowRun(id)` — fetch single workflow run
  - `cancelWorkflowRun(id)` — cancel a workflow run
- **New interface** `WorkflowRun` type for the dashboard

### 5. New file: `src/state/db.test.ts`

- Test `workflow_runs` table CRUD operations
- Test phase transition logic (create → update phase → finish)
- Test `getWorkflowRunByTrigger` finds latest active run
- Test idempotency of phase updates
- Test JSON serialization/deserialization of `phase_history` and `context`

### 6. New file: `vitest.config.ts` + `package.json` test script

- Add vitest as dev dependency
- Configure vitest for TypeScript
- Add `"test": "vitest run"` script to package.json
- This unblocks the guardrails check (issue #10)

## Implementation Approach

### Step 1: Test Infrastructure Setup
1. Install vitest: `npm install -D vitest`
2. Create `vitest.config.ts` with TypeScript support
3. Add `"test": "vitest run"` to package.json scripts
4. Verify `npx vitest run` works (zero tests, zero failures)

### Step 2: New Table and DB Methods
1. Add `WorkflowRun` and `PhaseHistoryEntry` interfaces to `src/state/db.ts`
2. Add `workflow_runs` table DDL to `migrate()`:
   ```sql
   CREATE TABLE IF NOT EXISTS workflow_runs (
     id TEXT PRIMARY KEY,
     workflow_name TEXT NOT NULL,
     trigger_id TEXT NOT NULL,
     repo TEXT,
     issue_number INTEGER,
     current_phase TEXT NOT NULL,
     phase_history TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL DEFAULT 'running',
     context TEXT,
     started_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     finished_at TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_trigger ON workflow_runs(trigger_id, status);
   CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
   ```
3. Add query methods: `createWorkflowRun`, `updateWorkflowPhase`, `finishWorkflowRun`, `getWorkflowRun`, `getWorkflowRunByTrigger`, `activeWorkflowRuns`, `recentWorkflowRuns`, `cancelWorkflowRun`
4. Write tests in `src/state/db.test.ts` — use in-memory SQLite (`:memory:`) for fast tests

### Step 3: Orchestrator Refactor
1. At the top of `runBuildCycle()`, look up or create the workflow run in DB
2. Replace the resume-check agent call with `db.getWorkflowRunByTrigger(triggerId)`:
   - If found with status `running`/`paused`: read `current_phase` from DB, set `resumeFrom` accordingly
   - If found with status `succeeded`: return early
   - If found with status `failed`/`cancelled`: create a new run (retry)
   - If not found: create a new run
3. After each `runPhase()` call succeeds, call `db.updateWorkflowPhase()` with:
   - The new phase name
   - A `PhaseHistoryEntry` containing: phase name, timestamp, success, and optionally a brief output summary
4. On build cycle completion: `db.finishWorkflowRun(workflowId, "succeeded")`
5. On any phase failure: `db.finishWorkflowRun(workflowId, "failed", errorMessage)`
6. Store `{ branch, taskId, models }` in the workflow run's `context` field
7. Keep `status.md` writing in prompts — agents still write it as a convenience, but resume no longer depends on it

### Step 4: Admin API + Dashboard
1. Add `/workflow-runs`, `/workflow-runs/:id`, and `/workflow-runs/:id/cancel` routes
2. Add corresponding `api` methods in the dashboard client
3. Add `WorkflowRun` TypeScript interface to dashboard

### Step 5: Verification
1. Run `npx tsc --noEmit` — must pass with zero errors
2. Run `npx vitest run` — all tests pass
3. Manual review: ensure DB is source of truth, `status.md` is convenience only

## Risks and Edge Cases

1. **Migration on existing DB**: The `CREATE TABLE IF NOT EXISTS` pattern is safe for existing databases — no data migration needed since this is a new table.

2. **Concurrent workflow runs for same trigger**: `getWorkflowRunByTrigger` must return the most recent active run, not just any run. If a previous run failed, a new build request should create a new run, not resume the failed one. Query should filter by `status IN ('running', 'paused')` and `ORDER BY started_at DESC LIMIT 1`.

3. **Phase history JSON growth**: Each phase appends an entry. For a typical build cycle (guardrails → architect → executor → reviewer → fix × 2 → PR), this is ~8 entries — negligible. No pagination needed.

4. **Crash mid-phase**: If the process crashes after a phase completes but before `updateWorkflowPhase` is called, the DB will show the previous phase. On restart, the orchestrator re-checks DB state and may re-run the last phase. This is safe because `runPhase` already has deduplication via the `executions` table — the execution will show as `done` and be skipped.

5. **Backward compatibility**: Existing `executions` table and `shouldRunPhase`/`markStaleAsFailed` stay intact. The `workflow_runs` layer is additive. The orchestrator still uses `runPhase()` with its execution-level deduplication — workflow runs add the higher-level state machine on top.

6. **status.md divergence**: If the agent writes a different phase to `status.md` than the DB records, the DB wins. The resume-check agent call can be kept as a fallback for branches created before this change (backward compat), but new runs use DB exclusively.

7. **Dashboard without workflow data**: The dashboard additions are additive API/client methods. No existing UI changes required initially — workflow data can be surfaced incrementally.

## Test Strategy

1. **Unit tests (`src/state/db.test.ts`)**:
   - Create workflow run → verify row exists with correct fields
   - Update phase → verify `current_phase` changed, `phase_history` contains entry, `updated_at` advanced
   - Finish run → verify `status`, `finished_at` set
   - Get by trigger → returns latest active run, ignores failed/cancelled
   - Cancel → sets status to `cancelled`
   - Active runs → only returns running/paused
   - Recent runs → respects limit, ordered by `started_at DESC`
   - Context JSON round-trip → store object, retrieve identical object

2. **Integration considerations**: The orchestrator refactor touches control flow but delegates to the same `runPhase()` function. The key behavioral change is how resume works — instead of cloning a branch and parsing a file, it queries a local DB table. This is strictly simpler and more reliable.

3. **Type checking**: `npx tsc --noEmit` must pass — the new interfaces and methods must be type-safe.

## Estimated Complexity

**Medium** — the DB schema and methods are straightforward (CRUD on a single table with JSON columns), and the orchestrator changes are primarily replacing the resume-check agent call with a DB lookup + adding `updateWorkflowPhase` calls after each phase. The main risk is getting the phase transition logic right in the orchestrator, but the existing `runPhase()` deduplication stays intact as a safety net.
