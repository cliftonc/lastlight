/**
 * Admission controller for the global concurrency cap (issue #172).
 *
 * When `runSimpleWorkflow` creates a run with `status: 'queued'` instead of
 * `status: 'running'` (because `countRunning() >= maxWorkflows`), this
 * controller is responsible for promoting queued runs to running as slots free.
 *
 * Two promotion paths:
 *  1. **Event-driven**: `admitNext()` is called in `dispatchWorkflow`'s
 *     `finally` block so a just-finished run immediately frees its slot.
 *  2. **Periodic sweep**: `setInterval(sweep, sweepIntervalMs)` (default 15 s)
 *     also performs TTL expiry of stale queued runs before admitting.
 *
 * Concurrency safety: `admitRun` is a CAS (`WHERE status = 'queued'`), so
 * only the first caller wins a given row — the event-driven and periodic
 * paths can race safely.
 *
 * Admission reuses `resumeSimpleRun` (from resume.ts): a queued run's stored
 * `context` is identical in shape to what resumeSimpleRun reconstructs from,
 * and the ledger's `shouldRunPhase` will run all phases (none have run yet).
 * This avoids duplicating dispatch plumbing and naturally bypasses the cap
 * (resumes enter `runWorkflow` directly, not the fresh-run gate).
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import { resumeSimpleRun, type ResumeOptions } from "./resume.js";

export interface AdmissionDeps {
  db: StateDb;
  resumeOpts: ResumeOptions;
  maxWorkflows: number;
  maxQueueWaitMs: number;
  /** How often the background sweep runs. Defaults to 15 000 ms. */
  sweepIntervalMs?: number;
}

export interface AdmissionController {
  /** Promote as many queued runs as free slots allow. */
  admitNext(): Promise<void>;
  /** TTL-expire stale queued runs, then call admitNext(). */
  sweep(): Promise<void>;
  /** Start the background sweeper interval. */
  start(): void;
  /** Stop the background sweeper interval. */
  stop(): void;
}

export function createAdmissionController(deps: AdmissionDeps): AdmissionController {
  const { db, resumeOpts, maxWorkflows, maxQueueWaitMs } = deps;
  const sweepIntervalMs = deps.sweepIntervalMs ?? 15_000;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function admitNext(): Promise<void> {
    // Re-read the running count and queued list on each iteration so we don't
    // race against concurrent admits or ongoing resumes changing the count.
    for (;;) {
      if (db.runs.countRunning() >= maxWorkflows) break;
      const queued = db.runs.listQueued();
      if (queued.length === 0) break;
      const next = queued[0];
      const changes = db.runs.admitRun(next.id);
      if (changes !== 1) {
        // CAS lost — another admitter won this row; re-check from scratch.
        continue;
      }
      // Won the CAS: reload the row (now `running`) and dispatch in the
      // background. Do NOT await — this is a long-running sandbox dispatch.
      const admitted = db.runs.getRun(next.id);
      if (admitted) {
        dispatchAdmitted(admitted, resumeOpts);
      }
      // Re-loop to admit more if additional slots are free.
    }
  }

  async function sweep(): Promise<void> {
    await expireStaleRuns(db, maxQueueWaitMs, resumeOpts);
    await admitNext();
  }

  function start(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      sweep().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[admission] Sweep failed: ${msg}`);
      });
    }, sweepIntervalMs);
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { admitNext, sweep, start, stop };
}

/** Fire-and-forget: resume a newly admitted run. */
function dispatchAdmitted(run: WorkflowRun, resumeOpts: ResumeOptions): void {
  resumeSimpleRun(run, resumeOpts).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admission] resumeSimpleRun failed for ${run.id}: ${msg}`);
  });
}

/** Expire queued runs that have waited longer than maxQueueWaitMs. */
async function expireStaleRuns(
  db: StateDb,
  maxQueueWaitMs: number,
  resumeOpts: ResumeOptions,
): Promise<void> {
  const queued = db.runs.listQueued();
  const now = Date.now();
  for (const run of queued) {
    const enqueuedAt = Date.parse(run.startedAt);
    if (now - enqueuedAt > maxQueueWaitMs) {
      const reason = "dropped from queue after waiting too long";
      const changed = db.runs.expireQueued(run.id, reason);
      if (changed === 1) {
        postExpiryAck(run, reason, resumeOpts).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[admission] Failed to post expiry ack for ${run.id}: ${msg}`);
        });
      }
    }
  }
}

/**
 * Best-effort: post a "dropped from queue" notification back to the
 * originating GitHub issue or Slack thread. Never throws — the row has
 * already been transitioned, so a failed ack is a UI gap, not a data hazard.
 */
async function postExpiryAck(
  run: WorkflowRun,
  reason: string,
  resumeOpts: ResumeOptions,
): Promise<void> {
  const msg = `Workflow \`${run.workflowName}\` was ${reason}.`;
  const stored = (run.context || {}) as Record<string, unknown>;

  // Slack-originated run: use slackPoster (channel/thread stored in context).
  if (run.triggerId.startsWith("slack:")) {
    const channelId = stored.channelId as string | undefined;
    const threadId = stored.threadId as string | undefined;
    if (resumeOpts.slackPoster && channelId && threadId) {
      await resumeOpts.slackPoster(channelId, threadId, msg);
    }
    return;
  }

  // GitHub-originated run: parse owner/repo from the trigger id.
  const coords = parseGitHubCoords(run);
  if (!coords || !run.issueNumber || !resumeOpts.github) return;
  await resumeOpts.github.postComment(coords.owner, coords.repo, run.issueNumber, msg);
}

/** Extract owner/repo from a GitHub trigger id. Returns null for non-GitHub ids. */
function parseGitHubCoords(run: WorkflowRun): { owner: string; repo: string } | null {
  const { triggerId } = run;
  const slashIdx = triggerId.indexOf("/");
  if (slashIdx < 0) return null;
  const hashIdx = triggerId.indexOf("#");
  const colonIdx = triggerId.indexOf("::");
  const end = hashIdx >= 0 ? hashIdx : colonIdx >= 0 ? colonIdx : triggerId.length;
  const owner = triggerId.slice(0, slashIdx);
  const repo = triggerId.slice(slashIdx + 1, end);
  if (!owner || !repo) return null;
  return { owner, repo };
}
