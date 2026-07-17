# Explore context: Limit concurrent in-process workflows (queue when over the cap)

## Idea summary
Last Light currently dispatches every triggering event straight into a workflow
run with no ceiling on how many run at once — a busy issue thread, a cron
fan-out, or a burst of PR events can spin up an unbounded number of concurrent
sandboxed agent runs and exhaust host resources. We want a **global concurrency
limiter** that caps the number of simultaneously-running workflows and **queues**
the excess, admitting queued work as running slots free up. The issue author
suggests placing the gate "before the Event envelope and before the router,"
and explicitly wants the design to be **robust** (survive restarts, avoid
deadlocks/starvation, integrate with the existing pause/resume + dedup model).

## Codebase overview
`nearform/lastlight` is a pnpm + Turborepo monorepo. The relevant app is
`apps/server/` (package `lastlight-core`) — a GitHub/Slack maintenance agent.
It listens for events (GitHub webhooks, Slack messages, CLI/API triggers, cron
ticks), normalizes them to an `EventEnvelope`, classifies/routes them, and runs
AI agents against a target repo. Non-trivial work is expressed as **YAML
workflows** (`build`, `pr-review`, `pr-fix`, `issue-triage`, `explore`,
`repo-health`, cron-*) executed phase-by-phase by a generic runner. Each phase
runs in an isolated **sandbox** (default `gondolin` in-process micro-VM; docker
and smol also supported). State is SQLite under `$STATE_DIR/data/lastlight.db`.

Key doc references: `apps/server/CLAUDE.md` (full dev guide),
`apps/server/src/workflows/CLAUDE.md` (runner internals),
`apps/server/spec/` (rebuild-grade spec).

## Relevant architecture

### Event → dispatch → workflow flow
```
Connector (github-webhook / slack / cli / cron)
  → EventEnvelope (src/connectors/types.ts)
    → MessageBatcher (messaging only; debounce bursts)      [src/index.ts ~L980]
      → handleEnvelope → dispatch()                          [src/engine/dispatcher.ts]
        → routeEvent()                                       [src/engine/router.ts]
        → (per-branch handlers) → dispatchWorkflow(name, ctx, onRunStart)
                                                              [closure in src/index.ts L247]
          → runSimpleWorkflow()                              [src/workflows/simple.ts]
            → db.runs.createRun({... status:'running'})  OR reuse existing run
            → runWorkflow()  (the scheduler)                 [src/workflows/runner.ts]
              → PhaseExecutor.execute() per phase
                → executeAgent() → sandbox (docker/gondolin) [src/engine/agent-executor.ts]
```

**`dispatchWorkflow` (`src/index.ts`, closure at L247)** is the single funnel
every trigger source passes through to start (or resume) a workflow:
- GitHub/Slack events via `dispatch()` (dispatcher.ts) — `handleBuild`,
  `handlePrFix`, `handleMessageDispatch`, `handleWebhookDispatch`,
  `handleExploreReply`, `handleApprovalResponse` all call `deps.dispatchWorkflow`.
- CLI/API `/api/run` and `/api/build` (src/index.ts ~L835, ~L867).
- Cron ticks via `dispatchCronWorkflow` (`src/cron/fanout.ts`) which already
  bounds *its own* fan-out concurrency (default 3) but each call still lands in
  the same `dispatchWorkflow`.
- Approval/retry resumes call `dispatchWorkflow` (dispatcher) or
  `resumeSimpleRun` (resume.ts) directly.

`dispatchWorkflow` is **fire-and-forget** at almost every call site (`.then/.catch`,
never awaited), so it returns a promise that resolves when the whole workflow
finishes. It is async but starts the run synchronously enough that
`runSimpleWorkflow` creates the `workflow_runs` row (status `running`) before the
first phase.

### Existing "already running" guard (the closest existing pattern)
`dispatch()` in dispatcher.ts already has a **per-trigger** dedup guard, not a
global limit:
```ts
const triggerId = String(envelope.issueNumber || envelope.id);
if (deps.db.executions.isRunning(handler, triggerId)) {
  // reply "already running" / skip
  return { kind: "skipped", reason: `${handler} already running for ${triggerId}` };
}
```
And `runSimpleWorkflow` reuses an existing live (`running`/`paused`) run for a
trigger via `db.runs.getByTrigger(triggerId)` rather than starting a second.
So double-dispatch of the *same* trigger is already prevented; what's missing is
a cap across *distinct* triggers.

### Workflow run state model (where a "queued" state would live)
`workflow_runs` table (`src/state/migrate.ts` L36):
```sql
CREATE TABLE workflow_runs (
  id, workflow_name, trigger_id, repo, issue_number,
  current_phase, phase_history, status TEXT NOT NULL DEFAULT 'running',
  context, started_at, updated_at, finished_at
);
CREATE INDEX idx_workflow_runs_trigger ON workflow_runs(trigger_id, status);
CREATE INDEX idx_workflow_runs_status  ON workflow_runs(status);
```
`WorkflowRun.status` (src/state/workflow-run-store.ts L19):
```ts
status: "running" | "paused" | "succeeded" | "failed" | "cancelled";
```
Store methods that matter for a queue:
- `createRun(...)` — inserts a row (currently always `status:'running'`).
- `getByTrigger(triggerId)` — most recent `running`/`paused` run for a trigger.
- `listActive()` — all `running`/`paused` runs (`WHERE status IN ('running','paused')`).
- `setRunning(id)` / `finishRun(id, status)` / `pauseRun` / `restartRun`.
- `incrementRestartCount(id)` — used by the restart circuit breaker.

Counting currently-running workflows is a one-liner over this table
(`SELECT COUNT(*) ... WHERE status='running'`), which is the natural signal for
the limiter. Note `paused` runs hold no sandbox — they're waiting on human
approval — so the cap should almost certainly count `running`, not `paused`.

### Restart recovery (why persistence matters for robustness)
`resumeOrphanedWorkflows` (src/workflows/resume.ts) runs at boot: it finds all
`status='running'` runs (orphaned by the crash), clears their stale execution
rows, bumps a per-run restart counter (circuit breaker `MAX_RESTART_RESUMES=3`),
and re-dispatches them. `paused` runs are intentionally left for human resume.
Any new `queued` state must be handled here too — on boot, queued runs should be
re-admitted (or stay queued) rather than lost or treated as orphans.

### Cron already has a local concurrency bound (prior art)
`dispatchCronWorkflow` (src/cron/fanout.ts) batches per-repo dispatches with
`Promise.allSettled` at `concurrency` (default 3). This is *per-cron-tick* local
throttling, not a global limit — a global limiter would supersede/compose with
it.

## Key code excerpts

**`src/engine/dispatcher.ts` — the dispatch funnel + existing dedup guard**
(the issue's suggested gate location is "before the envelope and before the
router"; in practice the natural single choke point is here or in
`dispatchWorkflow`):
```ts
export async function dispatch(envelope: EventEnvelope, deps: DispatchDeps): Promise<DispatchOutcome> {
  const route = await (deps.route ?? routeEvent)(envelope, { db: deps.db });
  if (route.action === "ignore") return { kind: "ignored", reason: route.reason };
  if (route.action === "reply") { await envelope.reply(route.message); return { kind: "replied", message: route.message }; }
  // ... handler branches ...
  // dedup guard (per-trigger, NOT a global cap):
  const triggerId = String(envelope.issueNumber || envelope.id);
  if (deps.db.executions.isRunning(handler, triggerId)) {
    return { kind: "skipped", reason: `${handler} already running for ${triggerId}` };
  }
  // ...handleBuild / handlePrFix / handleMessageDispatch / handleWebhookDispatch
}
```

**`src/index.ts` L247 — `dispatchWorkflow` closure (single funnel to the runner)**
```ts
const dispatchWorkflow = async (
  workflowName: string,
  context: Record<string, unknown>,
  onRunStart?: (runId: string) => Promise<void>,
): Promise<{ success: boolean; error?: string; paused?: boolean }> => {
  // ...validates repo, enriches issue context, resolves branch...
  const result = await runSimpleWorkflow(workflowName, request, {...}, callbacks, db, ...);
  return { success: result.success, paused: result.paused };
};
```
Called fire-and-forget everywhere, e.g. `handleMessageDispatch`:
```ts
deps.dispatchWorkflow(handler, { ...workflowContext, _triggerType: "chat" }, onRunStart)
  .then(async (result) => { /* reply completed/failed/paused */ })
  .catch(...);
return { kind: "dispatched", workflow: handler };
```

**`src/workflows/simple.ts` — run creation (where status is set to running)**
```ts
db.runs.createRun({
  id: workflowId, workflowName, triggerId, repo,
  issueNumber: issueNumber ?? prNumber,
  currentPhase: definition.phases[0]?.name || "phase_0",
  status: "running",                         // <-- would become 'queued' when over cap
  context: { kind, owner, branch, taskId, issueDir, prePopulateBranch, models, variants, ...extra },
  startedAt: new Date().toISOString(),
});
```

**`src/state/workflow-run-store.ts` — the queryable run state**
```ts
getByTrigger(triggerId): // WHERE trigger_id = ? AND status IN ('running','paused')
listActive(): // WHERE status IN ('running','paused') ORDER BY started_at DESC
setRunning(id): // UPDATE ... SET status='running'
finishRun(id, 'succeeded'|'failed'|'cancelled', {error?})
```

**`src/workflows/resume.ts` — boot recovery over `running` runs**
```ts
export async function resumeOrphanedWorkflows(opts) {
  const active = opts.db.runs.listActive();
  const orphans = active.filter((r) => r.status === "running");
  // clear stale executions, incrementRestartCount w/ MAX_RESTART_RESUMES=3,
  // resumeSimpleRun(run) in background
}
```

**`src/cron/fanout.ts` — existing local concurrency bound (prior art)**
```ts
const concurrency = Math.max(1, options.concurrency ?? 3);
for (let i = 0; i < repos.length; i += concurrency) {
  const batch = repos.slice(i, i + concurrency);
  await Promise.allSettled(batch.map((repo) => runOne(dispatch, workflowName, { ...rest, repo })));
}
```

**`config/default.yaml` — where a limit knob would be declared** (e.g. under a
new `concurrency:` or extending `sandbox:`):
```yaml
sandbox:
  backend: gondolin
  maxTurns: 200
```
Config is layered: `config/default.yaml` → `$LASTLIGHT_OVERLAY_DIR/config.yaml`
→ env overrides (`src/config/config.ts`, `config-resolve.ts`). Runtime type is
`LastLightConfig` (config.ts L89); `getRuntimeConfig()` exposes it.

## Existing patterns to follow
- **Config**: add a typed field to `LastLightConfig`, parse it in
  `config-resolve.ts` (with a default + optional env override like `MAX_TURNS`),
  document it in `config/default.yaml`. Secrets stay env-only; scalars/maps get
  a default.
- **DB / state**: schema changes go in `src/state/migrate.ts` (idempotent
  `CREATE TABLE IF NOT EXISTS` / additive `ALTER TABLE ... ADD COLUMN` guarded by
  a pragma check — see existing additive columns like `extension_status`). New
  query methods live on the relevant store class (`WorkflowRunStore`) with unit
  tests. Status is a string union — adding `'queued'` touches the union type +
  every `status IN (...)` query that should/shouldn't include it.
- **Atomicity**: lifecycle transitions that must not race are done in a single
  better-sqlite3 transaction (see `resolveGateAndResume`, `restartRun`'s
  compare-and-set `WHERE status='failed'`). A queue admission ("pick next queued
  → set running") should be a compare-and-set to avoid admitting two at once.
- **Testing**: co-located `*.test.ts` with vitest. `runner.test.ts`,
  `phase-executor.test.ts`, store tests, `fanout` has a test. The dispatcher is
  deliberately a single testable seam (`dispatch()` returns a typed
  `DispatchOutcome`) — a limiter decision should surface as an assertable
  outcome (e.g. a new `{ kind: "queued" }`).
- **Fire-and-forget dispatch**: callers don't await `dispatchWorkflow`; they act
  on the returned promise via `.then`. A queue must preserve the user-facing acks
  (👀 reaction, "Starting *X*…" Slack reply, in-progress Check Run) — decide
  whether those fire at enqueue time or admission time.
- **Restart circuit breaker**: mirror `MAX_RESTART_RESUMES` thinking — a robust
  queue needs to avoid starvation and unbounded growth.

## Decisions made during exploration
- Gate location → inside `dispatchWorkflow` (src/index.ts L247), the single funnel all triggers share (settled with maintainer, iter 1).
- Queue persistence → new `'queued'` status in `workflow_runs`, not an in-memory queue (crash-safe, dashboard-visible; settled iter 1).
- Priority → approval resumes + orphan restarts jump ahead of fresh queued work (in-flight finishes first; settled iter 1).
- Admission trigger → both event-driven (pull next queued on `finishRun`) AND a periodic sweeper as a safety net (crash-safe; mirrors how orphan recovery + dashboard polling already work). Low-stakes, following existing belt-and-suspenders patterns.
- Admission atomicity → compare-and-set transaction (`UPDATE ... SET status='running' WHERE id=? AND status='queued'`) to prevent double-admission, mirroring `restartRun`'s CAS. Low-stakes.
- `paused` runs → do NOT count toward the cap (hold no sandbox). Low-stakes, already the clear lean.
- Dedup composition → a `queued` run counts as "active" for `getByTrigger` reuse + the `isRunning` guard (so a second trigger for the same issue reuses/skips), but does not consume a running slot. Low-stakes.
- No nested-dispatch deadlock → verified (grep, iter 3): `dispatchWorkflow` is only called by trigger sources, cron fan-out, resumes, and CLI/API — never from inside a running phase. So a workflow holding a slot can never block on a queued sub-workflow. No special deadlock handling needed. Low-stakes.
- Config surface → new top-level `concurrency:` block with `maxWorkflows` (default 4), env override `MAX_CONCURRENT_WORKFLOWS`, parsed in `config-resolve.ts` like `MAX_TURNS`. Not folded into `sandbox:` since the cap is about run scheduling, not sandbox internals. Low-stakes, follows existing config pattern.
- User feedback → fire the existing user-facing ack at enqueue time (reaction / "queued, will start when a slot frees" reply / queued Check Run), then the existing "Starting…/completed" flow proceeds at admission. Dashboard shows `queued` automatically via the 5s poll. Low-stakes; preserves the fire-and-forget contract (caller still acts on the same returned promise, which now resolves after the queued→running→finished lifecycle).
- Queue bounds/staleness → TTL-based expiry (`concurrency.maxQueueWaitMs`, default ~30 min), NOT a hard depth cap; rely on existing dedup for storms; no per-workflow freshness check. TTL must be configurable in `config/default.yaml` + overlay (settled with maintainer, iter 3/5). Expired queued runs finish as `cancelled` (reuse terminal state) with a user-facing "dropped after waiting too long" ack.
- Cap shape → single global integer cap (`concurrency.maxWorkflows`, default 4, env `MAX_CONCURRENT_WORKFLOWS`), counting only `running` runs; no per-type/per-repo sub-caps in v1 (settled iter 2).
- Chat turns → excluded from the cap (`handleChat` runs in-process via pi-ai, latency-sensitive; settled iter 2).
- Resume/restart vs cap → Option A soft ceiling: resumes + orphan restarts bypass the cap and start immediately even if `running` momentarily exceeds it; count-toward-cap query stays `COUNT(*) WHERE status='running'`, so fresh queued admission naturally pauses while an overshoot drains. Cap stays a hard ceiling for fresh work only (settled iter 4). Overshoot is self-limited by human click rate + `MAX_RESTART_RESUMES=3`.
- Backend awareness → single backend-agnostic cap for v1 (default tuned for gondolin in-process, the current default). Per-backend caps documented as a future extension. Low-stakes.

## What we know
- There is currently **no global concurrency limit**; every trigger that routes
  to a workflow starts a run immediately. The only throttles are (a) the
  per-trigger dedup guard in `dispatcher.ts` / `getByTrigger` reuse, and (b) the
  per-cron-tick fan-out bound (default 3) in `src/cron/fanout.ts`.
- `dispatchWorkflow` (src/index.ts L247) is the single funnel all trigger
  sources pass through to start/resume a run — the most natural place to gate,
  more so than "before the envelope/router" since resumes and CLI/cron bypass the
  router entirely.
- Workflow run lifecycle is persisted in `workflow_runs` with a `status` string
  union (`running|paused|succeeded|failed|cancelled`) and rich store methods;
  counting `running` runs is a trivial query. Adding a `queued` status is the
  natural persistence model and makes the queue crash-safe.
- `paused` runs (awaiting human approval) hold no sandbox, so they should not
  count against the running cap.
- Boot recovery (`resumeOrphanedWorkflows`) already re-dispatches orphaned
  `running` runs with a restart circuit breaker — the queue must integrate here.
- Cron fan-out already demonstrates the project's accepted pattern for bounded
  concurrency (batch + `Promise.allSettled`).
- Sandbox backend is gondolin (in-process) by default; "in process workflows"
  in the title refers to workflows the harness runs itself, and the resource
  pressure is real because gondolin runs in the harness process space.

## What's unclear
- **Scope of the limit**: global across all workflows, or per-workflow-type,
  per-repo, or per-sandbox-backend? (e.g. cheap triage vs. expensive build.)
- **What counts toward the cap**: only sandboxed workflow runs, or also chat
  turns (`handleChat` runs in-process via pi-ai, not the sandbox) and the cheap
  `type: bash`/`type: script` phases? Do `paused` runs (no sandbox) count? (Lean:
  no.)
- **Queue placement**: gate at `dispatchWorkflow` (single funnel, covers CLI/cron/
  resume) vs. the issue's suggested "before envelope/router" (only covers
  webhook/Slack path). Resumes and approval-gate re-entries especially need
  thought — should an approved build jump the queue?
- **Queue persistence & ordering**: in-memory queue (simple, lost on restart) vs.
  a `queued` status persisted in `workflow_runs` (crash-safe, visible in
  dashboard, must be handled by boot recovery). FIFO vs. priority (e.g. resumes /
  PR-fix ahead of cron scans)?
- **Admission trigger**: how does a queued run get promoted when a slot frees —
  event-driven (on `finishRun`, pull next), a periodic sweeper, or both (for
  crash-safety)?
- **Default limit value** and config surface: a single integer
  (`concurrency.maxWorkflows`?), env override name, and whether it extends
  `sandbox:` or gets its own block.
- **User feedback**: when queued, what does the user see? A "queued, position N"
  reply/reaction that updates on admission? The dashboard already polls
  `workflow_runs` every 5s, so a `queued` status would show automatically.
- **Interaction with existing dedup**: the per-trigger `isRunning` guard and
  `getByTrigger` reuse must compose cleanly with a queued state (a queued run is
  "active" for reuse purposes but not consuming a slot).
- **Starvation / fairness / timeouts**: max queue depth, max wait time, drop
  policy for stale queued events (a webhook queued for an hour may be obsolete),
  and avoiding deadlock if a workflow dispatches sub-workflows.
- **Backend awareness**: docker sandboxes are separate containers (limit ~ host
  CPU/mem/docker), gondolin runs in-process (limit ~ harness memory). Should the
  cap differ by backend?
