# Architect Plan — #172 Limit in-process workflows

## Problem Statement

Every trigger source funnels into the `dispatchWorkflow` closure
(`apps/server/src/index.ts:247`) → `runSimpleWorkflow`
(`apps/server/src/workflows/simple.ts:171`), which creates a `workflow_runs`
row with `status: 'running'` (`simple.ts:245`) and immediately executes the
phases in-process. There is no ceiling on concurrent runs, so a webhook storm,
cron fan-out, or several active build threads can spawn an unbounded number of
sandboxed agent runs — and because the default `gondolin` backend runs
in-process in the harness, this exhausts host memory/CPU. The only existing
throttles are the per-trigger dedup guard (`getByTrigger`,
`workflow-run-store.ts:154`) and the cron per-tick fan-out bound; neither caps
concurrency across *distinct* triggers.

We add a single global concurrency cap enforced at the one real funnel
(`runSimpleWorkflow`'s fresh-run branch), persisting excess work as a new
`queued` status in `workflow_runs` (crash-safe, dashboard-visible), admitting
queued runs as running slots free (via a CAS + the existing resume machinery),
and expiring stale queued runs via a configurable TTL.

## Summary of what needs to change

1. Add `'queued'` to the `WorkflowRun["status"]` union and audit every
   `status IN (...)` query.
2. Add store methods: `countRunning()`, `listQueued()`, `admitRun(id)` (CAS
   `queued → running`), `expireQueued(id, reason)` (`queued → cancelled`).
   Include `'queued'` in `getByTrigger` + `listActive` (dedup + dashboard-live);
   **exclude** it from the running count and from orphan restart.
3. Gate the fresh-run branch of `runSimpleWorkflow`: when
   `countRunning() >= maxWorkflows`, create the row as `'queued'`, post an
   enqueue ack, and return `{ success: true, queued: true, phases: [] }`
   without running phases. Also handle a duplicate trigger that lands on an
   existing `queued` run in `handleExistingRun` (return queued, do NOT execute).
4. Add an **admission controller** (`src/workflows/admission.ts`): promotes the
   next queued run (oldest `started_at` first) via `admitRun` CAS, then
   dispatches it through the **existing `resumeSimpleRun`** machinery (which
   reconstructs context from the row, runs the full workflow, and bypasses the
   cap — Option A). Triggered event-driven (after each `dispatchWorkflow`
   settles) **and** by a periodic sweeper (`setInterval`) that also performs TTL
   expiry.
5. Resumes/restarts bypass the cap automatically because they never re-enter
   the fresh-run branch (they call `runWorkflow`/`resumeSimpleRun` directly).
   No change required beyond confirming orphan recovery ignores `queued`.
6. New `concurrency:` config block (`maxWorkflows`, `maxQueueWaitMs`) with env
   overrides `MAX_CONCURRENT_WORKFLOWS` / `MAX_QUEUE_WAIT_MS`.
7. Dashboard: render `queued` as a recognised status badge; add it to the
   "active" status filter so queued runs show in the live view.

## Key design decisions (grounded in the code)

- **Gate location.** Only the *fresh-run* `else` branch of `runSimpleWorkflow`
  (`simple.ts:243–265`, the `db.runs.createRun({ status: 'running' })` site).
  Approval resumes (`dispatcher.ts` `handleApprovalResponse` →
  `resolveGateAndResume` sets `running` then re-dispatches → `runSimpleWorkflow`
  finds the existing *running* run → `handleExistingRun` → falls through to
  `runWorkflow`, never hitting `createRun`) and orphan/retry restarts
  (`resume.ts` `resumeSimpleRun` calls `runWorkflow` directly) both bypass this
  branch — so **Option A (resumes bypass the cap)** is the natural behaviour,
  not extra code.
- **Admission = resume.** A queued run's stored `context` is identical in shape
  to what `resumeSimpleRun` already reconstructs from. Admission therefore
  reuses `resumeSimpleRun`, so a promoted run runs the full workflow from phase
  0 (all phases are un-run, so the ledger `shouldRunPhase` runs them all) and
  bypasses the cap. This avoids duplicating dispatch plumbing.
- **Count query stays `COUNT(*) WHERE status='running'`** so a bypassing resume
  counts once running and fresh queued admission naturally pauses during an
  overshoot until `running` drains below the cap.
- **TTL uses `started_at`** (enqueue time) — no new column. Expired queued runs
  finish as `cancelled` (reuse the terminal state; no new `expired` status).
- **No schema/migration change needed for the column** — `workflow_runs.status`
  is a free `TEXT` column with `DEFAULT 'running'` and **no CHECK/enum
  constraint** (verified in `migrate.ts:41–48`), so `'queued'` is already
  storable. Only the TS union + query audits change. (Add nothing to
  `migrate.ts` except an optional index — see manifest.)

---

## Files to modify — exhaustive manifest

### 1. `apps/server/src/state/workflow-run-store.ts`
- **`WorkflowRun["status"]` union (L19):** change to
  `"queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled"`.
- **`getByTrigger` (L154–162):** change `status IN ('running', 'paused')` →
  `status IN ('queued', 'running', 'paused')` so a queued run counts as active
  for dedup reuse. Update the JSDoc ("running, paused, or queued").
- **`listActive` (L179–184):** change `status IN ('running', 'paused')` →
  `status IN ('queued', 'running', 'paused')`. Update JSDoc.
- **`list()` JSDoc (L191–207):** add `queued` to the documented status list.
  (No SQL change — it already passes `statuses` through verbatim.)
- **New method `countRunning(): number`** — `SELECT COUNT(*) AS c FROM
  workflow_runs WHERE status = 'running'`; return `c`. Doc: counts only
  sandbox-holding runs; excludes `queued` and `paused`.
- **New method `listQueued(): WorkflowRun[]`** — `SELECT * FROM workflow_runs
  WHERE status = 'queued' ORDER BY started_at ASC` (FIFO by enqueue time);
  `.map(deserialize)`. Used by the admission controller for next-pick + TTL
  sweep.
- **New method `admitRun(id: string): number`** — CAS mirroring `restartRun`
  (L316–327):
  ```sql
  UPDATE workflow_runs
  SET status = 'running', updated_at = ?
  WHERE id = ? AND status = 'queued'
  ```
  return `info.changes`. Doc: only the winner (changes === 1) dispatches;
  prevents double-admission. Do **not** touch `started_at`/`restart_count`.
- **New method `expireQueued(id: string, reason: string): number`** — CAS
  `queued → cancelled` with the reason recorded like `flipFinished`:
  ```sql
  UPDATE workflow_runs
  SET status = 'cancelled', finished_at = ?, updated_at = ?,
      context = json_patch(COALESCE(context,'{}'), json_object('error', ?))
  WHERE id = ? AND status = 'queued'
  ```
  return `info.changes` (only expire a still-queued row).

### 2. `apps/server/src/workflows/simple.ts`
- **Signature of `runSimpleWorkflow` (L164–177):** add a trailing optional
  param `concurrency?: { maxWorkflows: number; maxQueueWaitMs: number }`.
  (Do NOT add to `ExecutorConfig` — that type lives in the `workflow-engine`
  package and must not gain scheduling concerns.)
- **Fresh-run branch (the `else` at L242–266, `createRun({ status: 'running' })`):**
  before creating, compute
  `const overCap = concurrency && db.runs.countRunning() >= concurrency.maxWorkflows;`
  When `overCap`:
  - `createRun({ …, status: 'queued' })` (same context payload as today).
  - Post an enqueue ack via `notify(...)`: e.g.
    `` `\`${workflowName}\` is queued — the concurrency limit
    (${concurrency.maxWorkflows}) is reached. It'll start automatically when a
    slot frees.` `` (reuse the `notify` closure defined at L189).
  - **Do NOT call `callbacks.onRunStart`** and **do NOT** seed the status
    checklist / run `runWorkflow`. Return early:
    `return { success: true, queued: true, phases: [] };`
  Keep the existing `running` path unchanged when under cap (still calls
  `onRunStart`, checklist seed, `runWorkflow`).
- **`handleExistingRun` (L~430):** add a branch **before** the "already
  complete" check: `if (run.status === 'queued') { return { success: true,
  queued: true, phases: [] }; }` — a duplicate trigger for an already-queued run
  must be a dedup no-op, never fall through to `runWorkflow` (which would
  execute it outside the cap). Add a `console.log` noting the dedup.

### 3. `packages/workflow-engine/src/ports/ports.ts`
- **`WorkflowResult` (L56–61):** add `queued?: boolean;` (mirrors `paused?`).
  Rebuild the package (`pnpm --filter lastlight-workflow-engine build`) so
  `apps/server` picks up the new type — the guardrails report notes workspace
  packages must be built before typecheck/test.

### 4. `apps/server/src/workflows/runner.ts`
- No logic change; it re-exports `WorkflowResult` (L39). Confirm the new
  optional field flows through. `runWorkflow` never sets `queued` (queued runs
  never reach the scheduler), so no code edit — listed for completeness.

### 5. `apps/server/src/workflows/admission.ts` (NEW FILE)
Create an admission controller. Suggested shape:
```ts
export interface AdmissionDeps {
  db: StateDb;
  resumeOpts: ResumeOptions;         // reuse resume machinery for dispatch + TTL acks
  maxWorkflows: number;
  maxQueueWaitMs: number;
  sweepIntervalMs?: number;          // default 15_000
}
export function createAdmissionController(deps: AdmissionDeps): {
  admitNext(): Promise<void>;        // promote as many queued runs as free slots allow
  sweep(): Promise<void>;            // TTL-expire stale queued runs, then admitNext()
  start(): void;                     // setInterval(sweep, sweepIntervalMs)
  stop(): void;                      // clearInterval
};
```
Behaviour:
- **`sweep()`**: for each `db.runs.listQueued()`, if
  `Date.now() - Date.parse(run.startedAt) > maxQueueWaitMs`, call
  `db.runs.expireQueued(run.id, "dropped from queue after waiting too long")`;
  if it changed a row, post the user-facing "dropped after waiting too long" ack
  (see ack helper below). Then call `admitNext()`.
- **`admitNext()`**: loop while
  `db.runs.countRunning() < maxWorkflows` and a next queued run exists
  (`listQueued()[0]` after re-reading each iteration): call
  `db.runs.admitRun(next.id)`; if `changes === 1`, kick off
  `resumeSimpleRun(admittedRun, resumeOpts)` **in the background**
  (`.catch(log)`) — do NOT await it (long-running); re-check the count on the
  next loop iteration (the just-admitted run now counts as running). Break when
  no admissible run or no free slot. Guard against runaway loops (admittedRun's
  status is now `running`, so `listQueued()` no longer returns it).
- **Concurrency safety**: `admitRun` CAS guarantees only one admitter wins a
  given row even if the event-driven and periodic paths race.
- **TTL ack helper**: reconstruct a notifier from the run like `resume.ts`
  does — `parseTriggerId(run.triggerId)` (exported from `resume.ts`) →
  `github.postComment(owner, repo, issueNumber, msg)`; for `slack:` trigger ids
  use `resumeOpts.slackPoster` with `run.context.channelId/threadId`. Best-
  effort (`.catch(warn)`); never throw out of the sweep.

### 6. `apps/server/src/index.ts`
- **Import** `createAdmissionController` from `./workflows/admission.js`.
- **`dispatchWorkflow` closure (L247):** thread the cap. Pass a new
  `concurrency` argument to `runSimpleWorkflow(...)` (the last call at L580+):
  `{ maxWorkflows: config.concurrency.maxWorkflows, maxQueueWaitMs:
  config.concurrency.maxQueueWaitMs }`.
- **Event-driven admission:** after the `runSimpleWorkflow` call resolves,
  in a `.finally`/after the try/catch that returns the result, call
  `admissionController.admitNext().catch(...)` so a slot freed by a completed
  fresh run immediately pulls the next queued run. (Place it so it fires on both
  success and failure paths — a `finally` around the existing try at L579.)
- **Construct the controller** after `resumeOpts` is built (L686–711) and after
  `dispatchWorkflow` is defined:
  ```ts
  const admissionController = createAdmissionController({
    db, resumeOpts,
    maxWorkflows: config.concurrency.maxWorkflows,
    maxQueueWaitMs: config.concurrency.maxQueueWaitMs,
  });
  ```
  Note the ordering: `dispatchWorkflow` (L247) references
  `admissionController`, which is constructed later — capture it via a
  `let admissionController: ReturnType<...>` declared before L247 and assigned
  after `resumeOpts`, then referenced inside `dispatchWorkflow` (the closure
  runs long after boot, so late assignment is fine — mirror the existing
  late-bound `cron`/`notifier` patterns).
- **Start the sweeper** near the boot tail (right after
  `resumeOrphanedWorkflows(resumeOpts)` at L1040): `admissionController.start();`
  — the periodic sweep also admits any pre-existing queued rows on boot.
- **Graceful shutdown (`shutdown`, L1044+):** call
  `admissionController.stop();` alongside `cron.stopAll()`.

### 7. `apps/server/src/engine/dispatcher.ts`
- **`DispatchWorkflowFn` return type (L18–22):** add `queued?: boolean` to the
  resolved object: `Promise<{ success: boolean; error?: string; paused?:
  boolean; queued?: boolean }>`.
- **`DispatchOutcome` (L45–51):** add variant `| { kind: "queued"; workflow:
  string }` (assertable in tests; see Risks for the sync/async caveat).
- **`handleMessageDispatch` (L~205 `.then`):** add a `result.queued` branch
  **before** the `result.paused`/`result.success` checks — when queued, do NOT
  post `*handler* completed`; the enqueue ack was already posted by the workflow
  (`simple.ts`). Optionally post nothing (quiet) to avoid duplication.
- **`handleBuild` (L~430 `.then`):** guard the `Build cycle complete.` reply
  with `if (!result.queued)` so a queued build doesn't claim completion.
- **`handleWebhookDispatch`:** only logs; no functional change, but the PR
  Check Run completion `.then` at L~300 should skip completing the check when
  `result.queued` (leave the in-progress check as-is; admission's resume path
  does not re-link/complete it — documented limitation, see Risks). Add an
  `if (result.queued) return;` at the top of that `.then`.

### 8. `apps/server/src/config/config.ts`
- **`LastLightConfig` interface (L89+, near `maxTurns` at L111):** add
  ```ts
  concurrency: { maxWorkflows: number; maxQueueWaitMs: number };
  ```
- **`normalizeFileConfig` return type (L424–439):** add
  `concurrency: { maxWorkflows: number; maxQueueWaitMs: number };`.
- **`normalizeFileConfig` body (near L446–463):** add
  ```ts
  const concurrencyRaw = isPlainObject(raw.concurrency) ? raw.concurrency : {};
  const maxWorkflows = typeof concurrencyRaw.maxWorkflows === "number" && concurrencyRaw.maxWorkflows > 0
    ? concurrencyRaw.maxWorkflows : 4;
  const maxQueueWaitMs = typeof concurrencyRaw.maxQueueWaitMs === "number" && concurrencyRaw.maxQueueWaitMs > 0
    ? concurrencyRaw.maxQueueWaitMs : 1_800_000;
  ```
  and include `concurrency: { maxWorkflows, maxQueueWaitMs }` in the returned
  object (near `sandbox: { backend, maxTurns }` at L483).
- **`loadConfig` (near L295–296 where `maxTurns = fileCfg.sandbox.maxTurns`):**
  `const concurrency = fileCfg.concurrency;` and add `concurrency,` to the
  `config: LastLightConfig = { … }` literal (near L391).

### 9. `apps/server/src/config/config-resolve.ts` (env layer lives in `config.ts`'s `buildEnvConfigLayer`, L588)
- **`buildEnvConfigLayer` (config.ts L588–615, right after the `sandbox` block
  at L607–615):** add
  ```ts
  const concurrency: Record<string, unknown> = {};
  if (env.MAX_CONCURRENT_WORKFLOWS) concurrency.maxWorkflows = parseInt(env.MAX_CONCURRENT_WORKFLOWS, 10);
  if (env.MAX_QUEUE_WAIT_MS) concurrency.maxQueueWaitMs = parseInt(env.MAX_QUEUE_WAIT_MS, 10);
  if (Object.keys(concurrency).length) layer.concurrency = concurrency;
  ```
  (This is the same file/module as the sandbox env block — `config-resolve.ts`
  is a separate 68-line file for layer *merging*; the env-layer builder is in
  `config.ts`. No edit to `config-resolve.ts` itself is required.)

### 10. `apps/server/config/default.yaml`
- Add a top-level block after the `sandbox:` block (L39–41):
  ```yaml
  # Global concurrency limiter (issue #172). Caps how many sandboxed workflow
  # runs execute at once; excess triggers are persisted as `queued` in
  # workflow_runs and admitted when a slot frees. Resumes/orphan restarts bypass
  # the cap (finish in-flight work first). Queued runs older than
  # maxQueueWaitMs are cancelled with a "waited too long" notice.
  concurrency:
    maxWorkflows: 4          # env override: MAX_CONCURRENT_WORKFLOWS
    maxQueueWaitMs: 1800000  # 30 min; env override: MAX_QUEUE_WAIT_MS
  ```

### 11. Dashboard — `apps/server/dashboard/src/api.ts`
- **`WorkflowRun.status` type (L104):** add `"queued"`:
  `"queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled"`.

### 12. Dashboard — `apps/server/dashboard/src/components/WorkflowList.tsx`
- **`StatusBadge` (L38–46):** add a class for `queued`, e.g.
  `"badge-neutral": status === "queued"` (or `badge-warning` variant distinct
  from paused). Ensure the badge renders the literal `queued` text.

### 13. Admin API — `apps/server/src/admin/routes.ts`
- **`/workflow-runs` "active" mapping (L899–904):** include queued so the "live"
  filter shows queued runs: `statuses = ["queued", "running", "paused"];`.
  Update the comment at L888.
- **cancel guard (L976–980):** allow cancelling a `queued` run —
  `if (run.status !== "running" && run.status !== "paused" && run.status !==
  "queued")`. (A queued run should be cancellable from the dashboard.) The
  existing `cancelRun` flips to `cancelled` and is fine for a queued row.

### 14. Tests (co-located + `tests/`) — add/extend
- **`apps/server/tests/state/workflow-run-store.test.ts`** — new describes:
  `countRunning` (counts only running, excludes queued/paused), `listQueued`
  (FIFO by started_at), `admitRun` (CAS: 1 on queued, 0 on already-running /
  second call), `expireQueued` (queued→cancelled with reason; 0 when not
  queued), `getByTrigger`/`listActive` now include queued.
- **`apps/server/tests/workflows/simple.test.ts`** — the file currently only
  unit-tests pure helpers. Add a describe driving `runSimpleWorkflow` against an
  in-memory `StateDb` with a stub `runWorkflow` / fake config: over-cap creates
  a `queued` row + posts the enqueue ack + returns `{ queued: true }` and does
  NOT call `onRunStart`; under-cap runs as today; a duplicate trigger on a
  queued run returns `queued` without executing (`handleExistingRun`). If
  driving `runSimpleWorkflow` end-to-end is too heavy, at minimum test the
  cap-decision predicate and the `handleExistingRun` queued branch by extracting
  the predicate to a small exported pure helper.
- **`apps/server/tests/workflows/admission.test.ts`** (NEW) — with an in-memory
  `StateDb` and a stubbed `resumeSimpleRun` (inject via deps or spy): admits up
  to N, stops at cap; FIFO order; CAS prevents double-admission under a
  simulated race; TTL sweep cancels an old queued run and fires the ack;
  overshoot (running > cap from a bypassing resume) pauses fresh admission.
- **`apps/server/tests/engine/dispatcher.test.ts`** — assert a queued
  `dispatchWorkflow` result surfaces through `handleMessageDispatch`/`handleBuild`
  without a spurious "completed" reply; add the `{ kind: "queued" }` outcome
  assertion where observable.
- **`apps/server/tests/config.test.ts`** — `concurrency.maxWorkflows` defaults
  to 4, `maxQueueWaitMs` to 1800000; `MAX_CONCURRENT_WORKFLOWS` /
  `MAX_QUEUE_WAIT_MS` env overrides win; overlay value wins over default
  (add to `tests/config-overlay.test.ts` if that's where overlay precedence is
  covered).
- **`apps/server/tests/cron/fanout.test.ts`** — no change required (cron
  fan-out bound composes with the global cap); leave as-is (see Open Questions).

---

## Commands (from guardrails-report.md)

Run from `apps/server` unless noted. Build workspace packages first (the
guardrails report shows tests/typecheck fail until `lastlight-shared`,
`lastlight-workflow-engine`, and `agentic-pi` are built):

```bash
# from repo root — build workspace deps (needed because ports.ts changed)
pnpm --filter lastlight-workflow-engine build
pnpm --filter lastlight-shared build
pnpm --filter agentic-pi build      # if not already built

# tests (apps/server)
cd apps/server && npx vitest run

# lint / boundaries (apps/server)
cd apps/server && npx depcruise --config .dependency-cruiser.cjs src

# typecheck (apps/server)
cd apps/server && npx tsc --noEmit

# dashboard typecheck (after api.ts / WorkflowList.tsx edits)
cd apps/server/dashboard && npx tsc -b

# full CI gate (repo root)
pnpm turbo run typecheck test build
```

---

## Implementation approach (step-by-step)

1. **workflow-engine**: add `queued?: boolean` to `WorkflowResult`
   (`ports.ts`), rebuild the package.
2. **Store**: add `'queued'` to the union; audit `getByTrigger` + `listActive`
   to include it; add `countRunning`, `listQueued`, `admitRun`, `expireQueued`.
   Add store tests. Confirm `resumeOrphanedWorkflows` still filters
   `status === 'running'` (queued excluded automatically).
3. **Config**: add the `concurrency` block to `LastLightConfig`,
   `normalizeFileConfig`, `buildEnvConfigLayer`, and `default.yaml`. Add config
   tests.
4. **Gate**: thread `concurrency` into `runSimpleWorkflow`; implement the
   over-cap `queued` branch + enqueue ack + early return; add the queued branch
   to `handleExistingRun`. Add simple.ts tests.
5. **Admission controller**: new `admission.ts` reusing `resumeSimpleRun` +
   `parseTriggerId` + `slackPoster`. Add admission tests.
6. **Wire in index.ts**: pass `concurrency` to `runSimpleWorkflow`; construct
   the controller (late-bound `let`); call `admitNext()` in `dispatchWorkflow`'s
   `finally`; `start()` the sweeper at boot; `stop()` on shutdown.
7. **Dispatcher**: extend return/outcome types; handle `result.queued` in
   `handleMessageDispatch`, `handleBuild`, and the webhook Check-Run `.then`.
8. **Dashboard**: `api.ts` status type + `WorkflowList` badge; admin route
   "active" filter + cancel guard.
9. Run the full gate; fix typecheck fallout from the widened union (every
   `switch`/comparison on `WorkflowRun["status"]` — grep for `=== "cancelled"`
   etc. and confirm exhaustiveness where TS enforces it).

---

## Risks and edge cases (warn-and-surface everywhere; no silent drops)

- **Duplicate trigger on a queued run.** `getByTrigger` now returns queued, so a
  re-trigger reuses the row; `handleExistingRun` must return `queued` early
  (manifest §2) — otherwise it falls through to `runWorkflow` and executes
  outside the cap. Covered by a test. **User feedback:** re-post (or skip) the
  enqueue ack; never silently start it.
- **Stale/expired queued run.** Handled by TTL sweep → `expireQueued`
  (`cancelled`) **with a user-facing "dropped from queue after waiting too long"
  comment/Slack reply** (manifest §5). The reason string is written to
  `context.error` so the dashboard surfaces *why* it was cancelled — never a
  silent disappearance.
- **Admission ack path can't be reconstructed** (e.g. a Slack queued run whose
  `channelId/threadId` weren't stored, or `github` is null). The TTL/admission
  ack is best-effort: log a `console.warn` and continue expiring/admitting — the
  row still transitions correctly and is visible in the dashboard. Do **not**
  block admission on a failed ack. (Matches `resume.ts`'s best-effort posting.)
- **Overshoot from simultaneous resumes (Option A).** Multiple approvals landing
  at once can push `running` above `maxWorkflows` transiently. Intended and
  self-limiting (bounded by human clicks + `MAX_RESTART_RESUMES=3`). While
  overshot, `admitNext()`'s `countRunning() < maxWorkflows` check keeps fresh
  queued work paused until it drains. No action beyond the count semantics.
- **`dispatch()` returning `{kind:"queued"}` synchronously.** The webhook/message
  dispatch is fire-and-forget: `dispatch()` returns `{kind:"dispatched"}` before
  the workflow promise resolves, so the queue decision is not observable at the
  `dispatch()` return for those paths. **The real, robust contract is the
  persisted `queued` row + the `dispatchWorkflow` promise resolving to
  `{queued:true}`** — tests assert on those (store state + the promise), not on
  a synchronous `dispatch()` outcome. The `{kind:"queued"}` variant is added to
  the union for the paths that *can* observe it and for future use; document
  this in the code so it isn't mistaken for an always-synchronous signal.
- **Queued PR-review Check Run.** A queued PR-review's in-progress `last-light/
  review` check is created before dispatch but won't be completed by the resume
  path on admission (resume uses `makeCallbacks`, which lacks the check-run
  completion hook). Documented limitation for v1: the check stays "in progress"
  until admission's resume runs and the workflow's own terminal posting updates
  the PR. Skip completing the check on the queued path (`if (result.queued)
  return;`) rather than marking it neutral — do not emit a misleading "review
  errored/neutral" conclusion. Note in the PR description.
- **Widened status union → exhaustiveness.** Adding `queued` may surface TS
  errors anywhere a `WorkflowRun["status"]` is switched exhaustively (dashboard
  badges, admin filters). Grep `=== "cancelled"`, `=== "paused"`,
  `WorkflowRun["status"]` and handle `queued` in each — a missed branch is a
  render/logic bug, not a silent default.
- **Boot recovery vs queued.** `resumeOrphanedWorkflows` filters
  `status === 'running'`; queued rows are left untouched and admitted by the
  sweeper (which `start()`s at boot). Confirm the filter is NOT changed to
  include queued (that would execute queued runs as orphans, bypassing the cap).
- **Cap of 0 / misconfig.** `normalizeFileConfig` clamps `maxWorkflows` and
  `maxQueueWaitMs` to positive numbers, falling back to the defaults (4 /
  1_800_000) for non-numeric or `<= 0` values — so a bad overlay value can't
  wedge the queue (cap 0 would queue everything forever). Covered by a config
  test.
- **Sweeper race with event-driven admit.** Both call `admitRun` (CAS); only the
  winner dispatches. Safe by construction (mirrors `restartRun`).

---

## Test strategy

- **Unit (store):** in-memory `StateDb` — `countRunning`, `listQueued` (FIFO),
  `admitRun` CAS (1 then 0), `expireQueued` (→cancelled+reason, 0 when not
  queued), `getByTrigger`/`listActive` include queued.
- **Unit (config):** defaults, env overrides (`MAX_CONCURRENT_WORKFLOWS`,
  `MAX_QUEUE_WAIT_MS`), overlay precedence, positive-number clamping.
- **Behavioural (simple.ts):** over-cap → queued row + ack + no `onRunStart`;
  under-cap → running as today; duplicate-on-queued dedup no-op.
- **Behavioural (admission.ts):** admits up to N; FIFO; CAS no-double-admit;
  TTL expiry + ack; overshoot pauses fresh admission; boot admits pre-existing
  queued rows.
- **Dispatcher:** queued result → no "completed"/"Build cycle complete" reply;
  outcome type compiles.
- **Full gate:** `npx vitest run`, `depcruise`, `tsc --noEmit` in `apps/server`;
  `tsc -b` in `dashboard`; `pnpm turbo run typecheck test build` at root.

---

## Estimated complexity: **complex**

Touches the run-state union (ripples into every status query + dashboard),
introduces a new admission subsystem with CAS + a background sweeper + TTL
expiry, threads new config through three layers, and requires care around the
fire-and-forget dispatch contract and Option-A overshoot semantics. Mechanical
in each spot but broad, with real concurrency-correctness stakes.
