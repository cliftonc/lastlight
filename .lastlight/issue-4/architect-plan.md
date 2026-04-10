# Architect Plan — Issue #4: Approval Gates for Human-in-the-Loop Workflows

## Problem Statement

The build cycle in `src/engine/orchestrator.ts:159-527` runs Architect -> Executor -> Reviewer -> PR autonomously with no human checkpoints. Once triggered, there is no way for a maintainer to review the architect's plan before implementation begins, or to decide whether to attempt fixes after reviewer feedback. The orchestrator's `runBuildCycle()` function executes phases sequentially and synchronously — it has no concept of pausing, waiting for external input, and resuming. The workflow state system (`src/state/db.ts:91-107`) tracks `current_phase` and `status` but has no approval-specific persistence, and the router (`src/engine/router.ts:30-236`) has no handling for `/approve` or `/reject` commands.

## Summary of Changes

1. **New `workflow_approvals` table** in the DB migration for tracking approval requests and responses
2. **New DB methods** for creating, querying, and responding to approvals
3. **Orchestrator yield/resume** — the orchestrator must be able to pause at configured gate points, persist the pending approval, and exit cleanly; a separate resume path re-enters the orchestrator when approval arrives
4. **Router additions** — parse `/approve` and `/reject` commands from issue comments and Slack messages
5. **Event handler wiring** — when an approval command is routed, look up the pending approval, record the response, and resume the paused workflow
6. **Admin API endpoints** — list pending approvals, approve/reject from dashboard
7. **Config** — approval gate toggle and per-phase configuration
8. **Notification delivery** — post approval requests as clear issue comments with instructions

## Files to Modify

### `src/state/db.ts` — New table + methods

**Migration (after line 106):** Add `workflow_approvals` table:

```sql
CREATE TABLE IF NOT EXISTS workflow_approvals (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  gate TEXT NOT NULL,                    -- 'post_architect' | 'post_reviewer'
  summary TEXT NOT NULL,                 -- what the user sees (plan excerpt, reviewer verdict)
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  requested_by TEXT,                     -- who triggered the build
  responded_by TEXT,                     -- who approved/rejected
  response TEXT,                         -- rejection reason or approval note
  responded_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_workflow ON workflow_approvals(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON workflow_approvals(status);
```

**New methods to add (~line 442):**

- `createApproval(approval: {...}): void` — insert a new pending approval
- `getApproval(id: string): WorkflowApproval | null` — fetch by ID
- `getPendingApprovalForWorkflow(workflowRunId: string): WorkflowApproval | null` — find pending approval for a workflow
- `getPendingApprovalByTrigger(triggerId: string): WorkflowApproval | null` — join with `workflow_runs` to find pending approval by trigger (e.g. `owner/repo#N`)
- `listPendingApprovals(): WorkflowApproval[]` — all pending approvals (for dashboard)
- `respondToApproval(id: string, status: 'approved' | 'rejected', respondedBy: string, response?: string): void` — record the response

**New interface (~line 26):**

```typescript
export interface WorkflowApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy?: string;
  respondedBy?: string;
  response?: string;
  respondedAt?: string;
  createdAt: string;
}
```

### `src/engine/orchestrator.ts` — Yield points and resume logic

**Line 74 — Extend `PHASE_ORDER`:**
Add `"waiting_approval"` as a recognized phase status (not in PHASE_ORDER itself, but handle it in resume logic).

**Line 159-169 — Extend `runBuildCycle` signature:**
Add optional `approvalConfig` parameter:

```typescript
export interface ApprovalGateConfig {
  postArchitect: boolean;   // pause after architect, before executor
  postReviewer: boolean;    // pause after reviewer REQUEST_CHANGES, before fix loop
}
```

**Line 372-380 — Post-architect gate (primary gate):**
After `persistPhase("architect")` at line 372, before notifying "Starting implementation...":

```typescript
if (approvalConfig?.postArchitect) {
  // Create pending approval in DB
  const approvalId = randomUUID();
  db.createApproval({
    id: approvalId,
    workflowRunId: workflowId,
    gate: 'post_architect',
    summary: `Architect plan ready for review.\n- Branch: \`${branch}\`\n- Plan: \`.lastlight/issue-${issueNumber}/architect-plan.md\``,
    requestedBy: request.sender,
    createdAt: new Date().toISOString(),
  });

  // Update workflow status to paused
  db.updateWorkflowPhase(workflowId, 'waiting_approval', {
    phase: 'waiting_approval',
    timestamp: new Date().toISOString(),
    success: true,
    summary: `Waiting for approval: post_architect (${approvalId})`,
  });

  // Notify via issue comment
  await notify(
    `**Architect analysis complete** — approval required before implementation.\n\n` +
    `- Branch: \`${branch}\`\n` +
    `- Plan: \`.lastlight/issue-${issueNumber}/architect-plan.md\`\n\n` +
    `**To proceed:** comment \`@last-light approve\`\n` +
    `**To abort:** comment \`@last-light reject [reason]\``,
  );

  // Pause the workflow — set status and return
  if (db && workflowId) {
    db.finishWorkflowRun — NO, use a new method:
    db.pauseWorkflowRun(workflowId);
  }
  return { success: true, phases, paused: true };
}
```

**Return type change (line 169):**
Extend return type to `{ success: boolean; phases: PhaseResult[]; prNumber?: number; paused?: boolean }`.

**Line 454-457 — Post-reviewer gate (optional):**
After `REQUEST_CHANGES` verdict, before entering fix loop:

```typescript
if (approvalConfig?.postReviewer && fixCycles < MAX_FIX_CYCLES) {
  // Same pattern: create approval, pause workflow, notify, return
  const approvalId = randomUUID();
  db.createApproval({
    id: approvalId,
    workflowRunId: workflowId,
    gate: 'post_reviewer',
    summary: `Reviewer requested changes (cycle ${fixCycles + 1}/${MAX_FIX_CYCLES}).\nVerdict: \`.lastlight/issue-${issueNumber}/reviewer-verdict.md\``,
    requestedBy: request.sender,
    createdAt: new Date().toISOString(),
  });
  // ... pause and notify same as above
}
```

**Resume logic (line 190-209):**
Extend the existing resume-from-DB path. When `existingRun.status === 'paused'` and `currentPhase === 'waiting_approval'`:
- Check `getPendingApprovalForWorkflow(workflowId)`
- If status is `'approved'` → set `resumeFrom` to the phase after the gate (executor for post_architect, fix_loop for post_reviewer), update workflow status to `'running'`
- If status is `'rejected'` → fail the workflow with the rejection reason
- If status is `'pending'` → do nothing (workflow stays paused; this path would be hit if someone re-triggers the build while waiting)

**New DB method needed (in db.ts):**
`pauseWorkflowRun(id: string): void` — sets `status = 'paused'`, `updated_at = now`.

### `src/engine/router.ts` — `/approve` and `/reject` commands

**Line 74-128 — Extend `comment.created` handler:**
Before the existing `classifyComment` call at line 95, add early detection for approval commands:

```typescript
// Check for approval commands before LLM classification
const approveMatch = envelope.body.match(/@last-light\s+approve\b/i);
const rejectMatch = envelope.body.match(/@last-light\s+reject\b(.*)/i);

if (approveMatch || rejectMatch) {
  return {
    action: 'skill',
    skill: 'approval-response',
    context: {
      repo: envelope.repo,
      issueNumber: envelope.issueNumber,
      sender: envelope.sender,
      decision: approveMatch ? 'approved' : 'rejected',
      reason: rejectMatch ? rejectMatch[1].trim() : undefined,
    },
  };
}
```

**Line 134-230 — Extend `message` handler:**
Add `/approve` and `/reject` slash commands (after `/status` at line 218):

```typescript
// Command: /approve [workflow_run_id] — approve pending gate
const approveSlash = text.match(/^\/approve(?:\s+(\S+))?$/i);
if (approveSlash) {
  return {
    action: 'skill',
    skill: 'approval-response',
    context: {
      workflowRunId: approveSlash[1],
      sender: envelope.sender,
      decision: 'approved',
      source: envelope.source,
    },
  };
}

// Command: /reject [workflow_run_id] [reason] — reject pending gate
const rejectSlash = text.match(/^\/reject(?:\s+(\S+))?(?:\s+(.+))?$/i);
if (rejectSlash) {
  return {
    action: 'skill',
    skill: 'approval-response',
    context: {
      workflowRunId: rejectSlash[1],
      sender: envelope.sender,
      decision: 'rejected',
      reason: rejectSlash[2],
      source: envelope.source,
    },
  };
}
```

### `src/index.ts` — Approval response handler

**Line 411 — Add handler before `github-orchestrator` check:**
Add a new block that handles the `approval-response` skill:

```typescript
if (skill === 'approval-response') {
  const decision = context.decision as 'approved' | 'rejected';
  const sender = context.sender as string;
  const reason = context.reason as string | undefined;
  const triggerId = context.repo && context.issueNumber
    ? `${context.repo}#${context.issueNumber}`
    : undefined;

  // Find the pending approval
  const approval = context.workflowRunId
    ? db.getPendingApprovalForWorkflow(context.workflowRunId as string)
    : triggerId
    ? db.getPendingApprovalByTrigger(triggerId)
    : null;

  if (!approval) {
    await envelope.reply('No pending approval found.');
    return;
  }

  // Record the response
  db.respondToApproval(approval.id, decision, sender, reason);

  if (decision === 'approved') {
    await envelope.reply(`Approved by ${sender}. Resuming build cycle...`);
    // Re-trigger the build cycle — the resume logic in orchestrator will pick up from the paused state
    // Re-dispatch as github-orchestrator event
    // ... (re-invoke runBuildCycle with same parameters, it will resume from DB state)
  } else {
    // Mark workflow as failed
    const workflowRun = db.getWorkflowRun(approval.workflowRunId);
    if (workflowRun) {
      db.finishWorkflowRun(approval.workflowRunId, 'failed', `Rejected by ${sender}: ${reason || 'no reason given'}`);
    }
    await envelope.reply(`Rejected by ${sender}. Build cycle aborted.${reason ? ` Reason: ${reason}` : ''}`);
  }
  return;
}
```

### `src/admin/routes.ts` — Dashboard API

**After line 313 — Add approval endpoints:**

```typescript
// Pending approvals
app.get('/approvals', (c) => {
  const approvals = db.listPendingApprovals();
  return c.json({ approvals });
});

// Approve/reject from dashboard
app.post('/approvals/:id/respond', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ decision: 'approved' | 'rejected'; reason?: string }>();
  const approval = db.getApproval(id);
  if (!approval) return c.json({ error: 'approval not found' }, 404);
  if (approval.status !== 'pending') return c.json({ error: `already ${approval.status}` }, 400);
  db.respondToApproval(id, body.decision, 'admin', body.reason);

  if (body.decision === 'approved') {
    // TODO: trigger workflow resume (same as issue comment path)
  } else {
    db.finishWorkflowRun(approval.workflowRunId, 'failed', `Rejected via dashboard: ${body.reason || 'no reason'}`);
  }
  return c.json({ status: body.decision });
});
```

### `src/config.ts` — Approval configuration

**Line 52-81 — Extend `LastLightConfig`:**

```typescript
/** Approval gate configuration */
approval?: {
  /** Enable post-architect approval gate (default: false) */
  postArchitect: boolean;
  /** Enable post-reviewer approval gate (default: false) */
  postReviewer: boolean;
};
```

**Line 87+ — Add to `loadConfig()`:**

```typescript
approval: {
  postArchitect: process.env.APPROVAL_POST_ARCHITECT === 'true',
  postReviewer: process.env.APPROVAL_POST_REVIEWER === 'true',
},
```

### `src/connectors/types.ts` — No changes needed

The existing `EventEnvelope` and `EventType` types are sufficient. Approval commands arrive as `comment.created` or `message` events, which are already handled.

## Implementation Approach

### Step 1: Database layer (`src/state/db.ts`)
- Add `WorkflowApproval` interface
- Add `workflow_approvals` table to migration
- Add `pauseWorkflowRun()` method
- Add approval CRUD methods: `createApproval`, `getApproval`, `getPendingApprovalForWorkflow`, `getPendingApprovalByTrigger`, `listPendingApprovals`, `respondToApproval`
- Add tests for new DB methods in `src/db.test.ts`

### Step 2: Configuration (`src/config.ts`)
- Add `approval` field to `LastLightConfig`
- Parse from env vars in `loadConfig()`
- Add to `config.test.ts`

### Step 3: Router (`src/engine/router.ts`)
- Add `/approve` and `/reject` pattern matching for both `comment.created` and `message` events
- Route to `approval-response` pseudo-skill
- Add tests in `src/router.test.ts`

### Step 4: Orchestrator (`src/engine/orchestrator.ts`)
- Accept `ApprovalGateConfig` parameter
- Add post-architect gate: create approval, pause workflow, notify, return early
- Add post-reviewer gate: same pattern
- Extend resume logic: when workflow is paused + approval is approved, resume from correct phase
- Extend return type to include `paused` flag

### Step 5: Event handler (`src/index.ts`)
- Add `approval-response` handler before `github-orchestrator` check
- Look up pending approval by trigger or workflow ID
- Record response and either resume build cycle or fail workflow
- Pass `approvalConfig` from config to `runBuildCycle()`

### Step 6: Admin API (`src/admin/routes.ts`)
- Add `GET /admin/api/approvals` — list pending
- Add `POST /admin/api/approvals/:id/respond` — approve/reject from dashboard
- Wire resume logic for dashboard approvals

### Step 7: Integration testing
- End-to-end: trigger build → architect completes → approval pending → approve → executor resumes
- Rejection: trigger build → architect → reject → workflow marked failed
- Resume: restart server → paused workflow with approved gate → resumes correctly
- No-gate mode: when approval config disabled, builds run without pausing (backwards compatible)

## Risks and Edge Cases

1. **Race condition on resume:** If an approval arrives while the orchestrator is shutting down from the pause, the resume re-trigger could race with the return. Mitigation: use the existing `shouldRunPhase` dedup — the workflow_runs status check prevents duplicate execution.

2. **Stale approvals:** A workflow might be cancelled while an approval is pending. Mitigation: the approval handler must check `workflow_runs.status` before resuming — if cancelled or failed, reject the approval.

3. **Multiple pending approvals:** The "no workflow_run_id" shortcut (`@last-light approve` on an issue) must resolve unambiguously. Mitigation: look up by `triggerId` (owner/repo#N) which is unique per active workflow.

4. **Server restart with paused workflows:** Paused workflows persist in the DB. On restart, they remain paused until an approval event arrives and re-triggers `runBuildCycle`. This is the correct behavior — no background polling needed.

5. **Backwards compatibility:** When `approval.postArchitect` and `approval.postReviewer` are both `false` (default), the orchestrator behaves exactly as before. No existing behavior changes.

6. **Authorization:** Only `MAINTAINER_ROLES` (OWNER, MEMBER, COLLABORATOR) can currently trigger builds (router.ts:81). The same check applies to approval commands since they flow through the same comment routing. No additional auth needed.

7. **Timeout:** The issue spec mentions no timeout for approvals. Approvals stay pending indefinitely until responded to or the workflow is cancelled. A future enhancement could add expiration via cron.

## Test Strategy

1. **Unit tests for DB methods** (`src/db.test.ts`):
   - Create approval, verify fields
   - Respond to approval, verify status change
   - Query pending approvals by workflow and by trigger
   - Attempt double-response (idempotency or rejection)

2. **Unit tests for router** (`src/router.test.ts`):
   - `@last-light approve` comment → routes to `approval-response` with `decision: 'approved'`
   - `@last-light reject some reason` → routes with `decision: 'rejected'`, reason extracted
   - `/approve` and `/reject` slash commands in message events
   - Non-maintainer approval attempt → still gets `polite-decline` (existing behavior)

3. **Unit tests for config** (`src/config.test.ts`):
   - Verify approval config defaults to disabled
   - Verify env var parsing

4. **Integration tests** (new file or extend existing):
   - Mock orchestrator: verify it creates approval and returns `paused: true` when gate is enabled
   - Mock orchestrator: verify it resumes from correct phase when approval found in DB

## Estimated Complexity

**Medium** — The core pattern (pause/resume via DB state) is straightforward and builds on existing workflow_runs infrastructure. The main complexity is wiring the approval response through the event handler back to the orchestrator's resume path, and ensuring the various entry points (issue comment, Slack, dashboard) all converge on the same logic.

Files touched: 6 (db.ts, orchestrator.ts, router.ts, index.ts, routes.ts, config.ts)
New test coverage: ~20-30 new test cases across existing test files
No new dependencies required.
