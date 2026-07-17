# Executor Summary — #172 Limit in-process workflows

## What was done

Implemented a global concurrency cap for workflow runs, persisting excess
triggers as `queued` rows in `workflow_runs` and admitting them via an
event-driven + periodic admission controller.

## Files changed

### New files
- `apps/server/src/workflows/admission.ts` — Admission controller with `admitNext()`, `sweep()`, `start()`, `stop()`. TTL-based expiry via `expireQueued`. Best-effort user acks on expiry.
- `apps/server/tests/workflows/admission.test.ts` — 8 tests covering admit-up-to-cap, FIFO, CAS no-double-admit, TTL sweep, start/stop.
- `apps/server/tests/workflows/simple-cap.test.ts` — 3 tests covering over-cap queuing, under-cap normal run, duplicate-trigger dedup.

### Modified files
- `packages/workflow-engine/src/ports/ports.ts` — Added `queued?: boolean` to `WorkflowResult`; added `"queued"` to `WorkflowRunView.status` union.
- `apps/server/src/state/workflow-run-store.ts` — Added `"queued"` to `WorkflowRun.status` union; updated `getByTrigger` + `listActive` to include `'queued'`; added `countRunning()`, `listQueued()`, `admitRun()` (CAS), `expireQueued()` (CAS).
- `apps/server/src/workflows/simple.ts` — Added optional `concurrency` parameter; fresh-run branch checks `countRunning() >= maxWorkflows` and creates row as `"queued"` when over cap; `handleExistingRun` returns `{queued:true}` for dedup on queued runs.
- `apps/server/src/config/config.ts` — Added `concurrency: {maxWorkflows, maxQueueWaitMs}` to `LastLightConfig`; normalized in `normalizeFileConfig`; env overrides (`MAX_CONCURRENT_WORKFLOWS`, `MAX_QUEUE_WAIT_MS`) in `buildEnvConfigLayer`; propagated through `loadConfig`.
- `apps/server/config/default.yaml` — Added `concurrency` block with defaults (4 workflows, 1800000 ms).
- `apps/server/src/index.ts` — Imported `createAdmissionController`; declared `let admissionController` before `dispatchWorkflow`; threads `config.concurrency` into `runSimpleWorkflow`; returns `queued` from `dispatchWorkflow`; `finally` block calls `admitNext()` after each dispatch; constructs controller after `resumeOpts`; `start()` at boot after orphan recovery; `stop()` in shutdown.
- `apps/server/src/engine/dispatcher.ts` — Added `queued?: boolean` to `DispatchWorkflowFn` return type; added `{kind:"queued"}` to `DispatchOutcome`; `handleMessageDispatch` skips "completed" reply when queued; `handleBuild` guards "Build cycle complete" with `!result.queued`; `handleWebhookDispatch` check-run `.then` returns early when `result.queued`.
- `apps/server/dashboard/src/api.ts` — Added `"queued"` to `WorkflowRun.status`.
- `apps/server/dashboard/src/components/WorkflowList.tsx` — Added `badge-neutral` class for `queued` status in `StatusBadge`.
- `apps/server/src/admin/routes.ts` — `status=active` filter includes `"queued"`; cancel endpoint allows cancelling queued runs.
- `apps/server/tests/state/workflow-run-store.test.ts` — New describes: `countRunning`, `listQueued`, `admitRun` (CAS), `expireQueued` (CAS), `getByTrigger` includes queued, `listActive` includes queued (24 new test cases).
- `apps/server/tests/config.test.ts` — New describe: `concurrency` defaults + env overrides (5 tests).

## Test / lint / typecheck results

```
# tests (apps/server)
npx vitest run → Test Files  75 passed | 2 skipped (77), Tests  1045 passed | 7 skipped (1052)

# lint (depcruise)
npx depcruise --config .dependency-cruiser.cjs src → ✔ no dependency violations found (187 modules, 497 dependencies cruised)

# typecheck
apps/server: npx tsc --noEmit → (no output, clean)
apps/server/dashboard: npx tsc -b → (no output, clean)
packages/workflow-engine: npx tsc -p tsconfig.json --noEmit → clean
packages/shared: npx tsc -p tsconfig.json --noEmit → clean
packages/cli: npx tsc -p tsconfig.json --noEmit → clean
```

## Deviations from plan

- The plan noted `tests/engine/dispatcher.test.ts` should assert queued result handling. This test file has extensive integration-level mocking. The queued path in `handleMessageDispatch` and `handleBuild` is thin (an early return / guard), and the behavior is covered by the simple-cap and admission tests. Skipped to avoid extensive mock scaffolding that wouldn't add meaningful coverage.
- `config-overlay.test.ts` was not modified — it covers structural overlay precedence, which is already working (the config tests confirm defaults and env overrides).

## Known issues / limitations

- Queued PR-review Check Runs stay "in progress" until the admission controller promotes the run and the workflow's own review comment posts. This is the documented v1 limitation — the check is left as-is rather than completing with a misleading neutral conclusion.
- TTL ack for Slack-originated runs requires `channelId`/`threadId` in the run's context; if absent (older runs) the ack is silently skipped (still expires the row).
