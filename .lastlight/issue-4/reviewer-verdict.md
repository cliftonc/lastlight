# Reviewer Verdict — Issue #4: Approval Gates for Human-in-the-Loop Workflows

## verdict: REQUEST_CHANGES

---

## Issues

### Critical

**`src/engine/orchestrator.ts:220` — `post_reviewer` gate resumes to wrong phase**

```typescript
resumeFrom = gate === "post_architect" ? "executor" : "executor";
```

Both branches of the ternary resolve to `"executor"`. When a `post_reviewer` gate is approved (after a reviewer returns REQUEST_CHANGES), the build cycle should resume from the **fix loop**, not restart from the executor phase. The correct expression should be:

```typescript
resumeFrom = gate === "post_architect" ? "executor" : "reviewer";
```

Resuming from `"executor"` after a reviewer gate would re-run the executor, discarding the reviewer's feedback and duplicating work. This is a logic error that makes the `post_reviewer` gate functionally broken for the server-restart-resume path.

Note: the primary resume path (via `index.ts:443` `db.resumeWorkflowRun` + `runBuildCycle` re-invocation) side-steps this bug because it re-enters the orchestrator as a fresh call after the approval is already responded to (the `status = 'approved'` approval is found by `getPendingApprovalForWorkflow` which only returns `status = 'pending'` approvals). However the fallback server-restart path at `orchestrator.ts:215-235` is definitely wrong.

---

### Important

**`src/index.ts:437` — Silent failure when `github` is null in approval handler**

```typescript
const workflowRun = db.getWorkflowRun(approval.workflowRunId);
if (workflowRun && github) {
```

When approval arrives via Slack (`/approve`) but the GitHub client is null (messaging-only mode, or GitHub App not configured), the approval is recorded in the DB (`respondToApproval` runs at line 431) but `runBuildCycle` is never called. The user receives "Resuming build cycle..." but the build never actually resumes. The workflow stays paused indefinitely with `status = 'approved'` in the approval table but `status = 'running'` in `workflow_runs` (from `resumeWorkflowRun` at line 443, which is inside the same `if` block so it also doesn't run).

This should either: (a) reply with an error when `github` is null, or (b) document that approval via Slack requires the GitHub App to be configured.

**`src/index.ts:258-261` — `/api/build` endpoint does not pass `config.approval`**

The `runBuildCycle` call in the `/api/build` endpoint omits the `approvalConfig` parameter. CLI-triggered builds never pause at approval gates, even when `APPROVAL_POST_ARCHITECT=true` is set. This is inconsistent with the webhook path which passes `config.approval` correctly. The plan specified that approval gates should apply to all build triggers.

---

### Suggestions

**`src/engine/orchestrator.ts:220` — Consider a const map instead of the ternary**

If more gate types are added in the future, a map would be clearer:

```typescript
const gateResumePhase: Record<string, Phase> = {
  post_architect: "executor",
  post_reviewer: "reviewer",
};
resumeFrom = gateResumePhase[gate] ?? "executor";
```

**`src/admin/routes.ts:329` — Dashboard approval does not resume build cycle**

The `POST /approvals/:id/respond` handler records the response and finishes failed workflows, but for approvals it does nothing to resume the build. The `// TODO: trigger workflow resume` comment from the plan was not implemented. The dashboard can approve but the build won't resume. This should be noted as a known limitation or implemented.

---

## Test Results

All tests pass:

```
 Test Files  5 passed (5)
      Tests  95 passed (95)
   Duration  955ms
```

TypeScript clean: `npx tsc --noEmit` exits 0.

---

## Summary

The core implementation — DB schema, approval CRUD methods, orchestrator gate insertion, router command parsing, config env vars — is correct and well-tested. The critical bug is the copy-paste error in `orchestrator.ts:220` where the `post_reviewer` ternary branch evaluates to `"executor"` instead of `"reviewer"`. The important issues are a silent failure mode when `github` is null and the CLI build path ignoring approval config.
