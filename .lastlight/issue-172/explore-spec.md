# Global concurrency limiter with a persisted `queued` state

## Problem
Last Light dispatches every triggering event straight into a workflow run with
no ceiling on how many run at once. A busy issue thread, a cron fan-out, or a
burst of GitHub/Slack events can spin up an unbounded number of concurrent
sandboxed agent runs. Because the default sandbox backend (`gondolin`) runs
in-process inside the harness, this directly exhausts host memory/CPU. Today the
only throttles are the per-trigger dedup guard in `dispatcher.ts` /
`getByTrigger` reuse and the per-cron-tick fan-out bound (default 3) in
`src/cron/fanout.ts` — neither caps concurrency across *distinct* triggers.

## Users
- **Operators** running a Last Light instance who need it to stay within host
  resource limits under load (webhook storms, cron fan-out, multiple active
  build threads).
- **Contributors/maintainers** interacting through GitHub/Slack: their triggers
  still get acknowledged and eventually run, rather than silently overwhelming
  the host and degrading every run.

## Goals
- Cap the number of simultaneously *running* sandboxed workflows at a single
  global integer, configurable via config/overlay/env.
- Queue excess work durably (crash-safe) instead of starting it immediately, and
  admit queued runs as slots free up.
- Preserve the existing user-facing acks and the fire-and-forget dispatch
  contract — a queued trigger still gets an ack now and runs later.
- Prioritise finishing in-flight, already-committed work (approval resumes,
  orphan restarts) over starting fresh queued work.
- Bound queue growth and avoid acting on stale work via a configurable wait TTL.

## Non-goals
- Per-workflow-type, per-repo, or per-sandbox-backend sub-caps (single global
  cap only in v1).
- Counting chat turns (`handleChat`, in-process pi-ai, latency-sensitive) toward
  the cap.
- Content-level staleness checks (e.g. "is this PR still open?") — TTL is the
  blunt proxy.
- A hard max-queue-depth that rejects at enqueue time.
- Guaranteeing a hard ceiling for resumes/restarts (they intentionally bypass
  the cap — see Proposed design).

## Proposed design

### Gate location
The limiter lives inside the **`dispatchWorkflow` closure** (`src/index.ts`
L247) — the single funnel every trigger source passes through (GitHub/Slack via
`dispatch()`, CLI/API `/api/run` + `/api/build`, cron via `dispatchCronWorkflow`,
and approval/orphan resumes). Gating "before the envelope/router" as originally
suggested in the issue would miss CLI/cron/resume paths, which bypass the router
entirely.

The natural insertion point is `runSimpleWorkflow` (`src/workflows/simple.ts`)
where `db.runs.createRun({ status: 'running' })` happens today. When at/over the
cap, the run is created with `status: 'queued'` instead of `'running'`, and the
runner does **not** start executing phases; it returns a "queued" result so the
caller's `.then` fires the queued ack. Existing `getByTrigger` reuse still runs
first, so a repeat trigger for the same issue/PR reuses the queued run rather
than creating a second.

### Persisted `queued` status
Add `'queued'` to the `WorkflowRun["status"]` union
(`src/state/workflow-run-store.ts` L19) and to the DB. The queue is the
`workflow_runs` table itself — no in-memory queue. This makes it crash-safe
(survives restart, swept by boot recovery), dashboard-visible for free (the
admin UI polls `workflow_runs` every 5s), and composable with existing dedup.

The status change touches every `status IN (...)` query — each must be audited:
- `getByTrigger` (L155) and `listActive` (L180): **include** `'queued'` so a
  queued run counts as "active" for dedup reuse and the dashboard "live" filter.
- The count-toward-cap query: `SELECT COUNT(*) FROM workflow_runs WHERE
  status = 'running'` — **excludes** `queued` and `paused` (neither holds a
  sandbox).
- `resumeOrphanedWorkflows` (`src/workflows/resume.ts`) filters
  `status === 'running'` for orphan restart — **excludes** `queued` (queued runs
  never started, so they are not orphans; they stay queued and get admitted by
  the sweeper).
- Dashboard `list()` status filter (`admin`) should surface `queued` as a
  recognised status.

### The cap
A single global integer, `concurrency.maxWorkflows` (default 4), env override
`MAX_CONCURRENT_WORKFLOWS`. It counts only `running` runs — the ones holding a
sandbox. `paused` (awaiting human approval) and `queued` runs do not count.
Chat turns are not routed through `dispatchWorkflow` as sandboxed workflows and
are excluded.

### Admission
When a running slot frees, the next queued run is promoted. Two triggers, for
robustness (belt-and-suspenders, mirroring orphan recovery + dashboard polling):
- **Event-driven**: on `finishRun` (and after `pauseRun`, which frees a slot),
  attempt to pull the next queued run.
- **Periodic sweeper**: a background interval re-checks for admissible queued
  runs (crash-safe safety net; also where TTL expiry happens).

Admission is a **compare-and-set transaction** to prevent double-admission,
mirroring `restartRun`'s CAS (`UPDATE workflow_runs SET status = 'running',
started_at/updated_at = ? WHERE id = ? AND status = 'queued'` returning
`info.changes`; only the winner dispatches). After the CAS commits, the caller
dispatches the run into the runner (long-running dispatch stays out of the
transaction, per the store's established pattern).

**Ordering / priority**: approval resumes and orphan restarts are in-flight,
already-committed work and take precedence over fresh queued runs. Among fresh
queued runs, FIFO by `started_at` (enqueue time).

### Resume/restart vs the cap (soft ceiling — Option A)
Approval resumes and orphan restarts **bypass the cap** and start immediately,
even if `running` momentarily exceeds `maxWorkflows`. Rationale: freeing the slot
on `paused` is a throughput optimization; re-gating the resume would reintroduce
the stall we avoided, and human-in-the-loop latency is the worst place to add a
queue wait. The overshoot is small and self-limiting (bounded by human click
rate + `MAX_RESTART_RESUMES=3`).

Because the count-toward-cap query stays `COUNT(*) WHERE status = 'running'`, a
bypassing resume *does* count once running — so while an overshoot is active,
fresh queued admission naturally pauses until `running` drains back under the
cap. The cap is thus a hard ceiling for **fresh** work (the real storm source)
and a soft one only for **already-committed** runs.

### Queue bounds & staleness (TTL)
Each queued run carries a wait deadline derived from `concurrency.maxQueueWaitMs`
(default ~30 min, `1800000`), configurable in `config/default.yaml` and the
overlay. The admission step and the periodic sweeper expire any queued run past
its TTL, finishing it as `cancelled` (reusing the existing terminal state and
dashboard rendering — no new `expired` status) with a clear reason, and firing
the user-facing "dropped from queue after waiting too long" ack. TTL bounds
growth (expired rows drain) without an arbitrary depth cap; the existing dedup
guard collapses same-trigger storms into a single queued row.

### User feedback
Fire the existing user-facing ack at **enqueue** time — reaction / a "queued,
will start when a slot frees" reply / a queued Check Run — then the existing
"Starting…/completed/failed" flow proceeds at **admission**. The dashboard shows
`queued` automatically via its 5s poll. The fire-and-forget contract is
preserved: callers still act on the same returned promise, which now resolves
after the queued → running → finished lifecycle (or after TTL cancellation).

### Config
New top-level `concurrency:` block in `config/default.yaml`:
```yaml
concurrency:
  maxWorkflows: 4        # env override: MAX_CONCURRENT_WORKFLOWS
  maxQueueWaitMs: 1800000  # 30 min; env override: MAX_QUEUE_WAIT_MS
```
Parsed in `src/config/config-resolve.ts` with defaults + env overrides, mirroring
the `MAX_TURNS` / `sandbox.maxTurns` pattern (config-resolve.ts L463, L614), and
typed on `LastLightConfig` (`src/config/config.ts` L89+). Kept separate from
`sandbox:` because the cap is about run scheduling, not sandbox internals.

## Key files to modify
| File | Change |
|------|--------|
| `apps/server/src/state/workflow-run-store.ts` | Add `'queued'` to `WorkflowRun["status"]` union; audit/adjust `getByTrigger` + `listActive` to include `queued`; add `countRunning()`, `nextQueued()`, an `admitRun(id)` CAS method, and an `expireQueued(id)` helper (→ `cancelled`). |
| `apps/server/src/state/migrate.ts` | Allow `queued` in the status column (string column, no enum — verify no CHECK constraint); no schema change beyond documentation if the column is a free string. Add any new index if needed for queued ordering. |
| `apps/server/src/workflows/simple.ts` | In `runSimpleWorkflow`, branch on the cap: create the run as `queued` (don't start phases) when over cap, else `running` as today; return a "queued" result. |
| `apps/server/src/index.ts` | `dispatchWorkflow` closure (L247): thread the cap decision + queued ack; wire the admission trigger on run completion; start the periodic sweeper. |
| `apps/server/src/engine/dispatcher.ts` | Add a `{ kind: "queued" }` `DispatchOutcome` variant so the limiter decision is assertable; ensure `isRunning` dedup composes with queued runs. |
| `apps/server/src/workflows/resume.ts` | Exclude `queued` runs from orphan restart; ensure resumes/restarts bypass the cap (Option A). |
| `apps/server/src/config/config.ts` | Add `concurrency: { maxWorkflows; maxQueueWaitMs }` to `LastLightConfig`. |
| `apps/server/src/config/config-resolve.ts` | Parse `concurrency` block with defaults + env overrides (`MAX_CONCURRENT_WORKFLOWS`, `MAX_QUEUE_WAIT_MS`). |
| `config/default.yaml` | Document the new `concurrency:` block. |
| Admin dashboard (status rendering/filter) | Surface `queued` as a recognised status. |
| Co-located `*.test.ts` (store, simple/runner, dispatcher, fanout) | Cover enqueue-over-cap, admission CAS, FIFO ordering, resume bypass/overshoot, TTL expiry, dedup composition. |

## Decisions made during exploration
- Admission trigger → both event-driven (pull next on `finishRun`) AND a periodic sweeper (crash-safe; mirrors orphan recovery + dashboard polling belt-and-suspenders).
- Admission atomicity → compare-and-set transaction (`UPDATE ... SET status='running' WHERE id=? AND status='queued'`) mirroring `restartRun`'s CAS (prevents double-admission).
- `paused` runs → do NOT count toward the cap (hold no sandbox).
- Dedup composition → a `queued` run counts as "active" for `getByTrigger` reuse + the `isRunning` guard, but does not consume a running slot.
- No nested-dispatch deadlock → verified `dispatchWorkflow` is never called from inside a running phase, so no special deadlock handling is needed.
- Config surface → new top-level `concurrency:` block (not folded into `sandbox:`), env override `MAX_CONCURRENT_WORKFLOWS`, parsed like `MAX_TURNS`.
- User feedback → ack at enqueue time, existing "Starting…/completed" flow at admission; dashboard shows `queued` via 5s poll; fire-and-forget contract preserved.
- Expired queued runs → finish as `cancelled` (reuse terminal state), not a new `expired` status.
- Backend awareness → single backend-agnostic cap for v1 (default tuned for gondolin in-process); per-backend caps deferred.

## Acceptance criteria
- With `maxWorkflows = N`, at most `N` runs are ever in `status = 'running'` due
  to *fresh* dispatch; the `N+1`th fresh trigger creates a `queued` run instead
  of starting immediately.
- A queued run is promoted to `running` (via CAS) when a running slot frees,
  triggered both by `finishRun` and by the periodic sweeper.
- Approval resumes and orphan restarts start immediately even when `running` is
  at/over the cap; while that overshoot is active, no *fresh* queued run is
  admitted until `running` drains below the cap.
- A second trigger for a trigger that already has a queued/running run reuses it
  (dedup) rather than creating another row.
- A queued run past `maxQueueWaitMs` is finished as `cancelled` with a
  user-facing "dropped after waiting too long" ack, by both the admission path
  and the sweeper.
- Queued runs survive a harness restart: on boot they remain `queued` (not
  treated as orphans, not lost) and are admitted when slots free.
- Queued runs are visible with `status = 'queued'` in the admin dashboard.
- `maxWorkflows` and `maxQueueWaitMs` are configurable via `config/default.yaml`,
  the overlay config, and env overrides.
- `dispatch()` returns an assertable `{ kind: "queued" }` outcome when a trigger
  is queued.

## Open questions
- Exact placement of the queued ack per surface (GitHub reaction vs. Check Run
  vs. Slack reply) and its wording — to be decided during implementation,
  reusing each surface's existing ack path.
- Whether the DB status column has a CHECK/enum constraint that must be widened
  for `queued` (verify in `migrate.ts`) — to be decided during implementation.
- Sweeper interval value (e.g. reuse an existing interval or a new
  ~15–30s tick) — to be decided during implementation.
- Whether cron's existing per-tick fan-out bound (default 3) should be reduced or
  left to compose with the global cap now that a global limiter exists.

## Out of scope
- Per-workflow-type / per-repo / per-backend sub-caps.
- Hard max-queue-depth with enqueue-time rejection.
- Content-level freshness checks for queued work.
- Counting chat turns or cheap non-sandbox phases toward the cap.
- A dedicated `expired` status (reusing `cancelled`).
