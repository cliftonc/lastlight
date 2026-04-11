# Architect Plan — Issue #8: Workflow Visualization in Admin Dashboard

## Problem Statement

The admin dashboard (`dashboard/src/App.tsx:1-229`) currently shows agent sessions and execution stats but has no way to visualize workflow runs — the Architect, Executor, Reviewer build cycle that is the core feature of Last Light. The backend API already exposes workflow run data via `GET /admin/api/workflow-runs` (`src/admin/routes.ts:291-304`) and approval gates via `GET /admin/api/approvals` (`src/admin/routes.ts:319-342`). The frontend API client already has types and methods for this data (`dashboard/src/api.ts:51-71, 160-168`). What's missing is the React UI to consume and display this data — a workflow runs list, a phase pipeline visualization, and approval gate interaction.

## Summary

Add a "Workflows" tab to the admin dashboard that shows:
1. A list of workflow runs (active, paused, completed) with status badges and timing
2. A visual phase pipeline for each workflow showing progress through guardrails, architect, executor, reviewer, PR phases
3. Pending approval gate actions (approve/reject buttons)
4. Cancel button for running/paused workflows
5. Auto-refresh to show live progress

## Files to Modify

### New Files

1. **`dashboard/src/components/WorkflowList.tsx`** — Main workflow runs list component
   - Fetches from `api.workflowRuns()` on interval
   - Shows each run: repo, issue, status badge, current phase, timing
   - Click to expand/select for detail view
   - Cancel button for running/paused runs

2. **`dashboard/src/components/WorkflowPipeline.tsx`** — Phase pipeline visualization
   - Horizontal pipeline showing phases: phase_0 > guardrails > architect > executor > reviewer > pr > complete
   - Each phase node shows: status (pending/active/done/failed), timestamp, duration
   - Derives state from `phaseHistory[]` and `currentPhase`
   - Color coding: green=success, blue=running, yellow=paused, red=failed, gray=pending
   - Supports DAG layout when `nodeStatuses` is present (parallel branches)

3. **`dashboard/src/components/ApprovalBanner.tsx`** — Approval gate interaction
   - Shows pending approvals with gate name and summary
   - Approve/Reject buttons with optional reason textarea
   - Calls `api` methods for `/approvals/:id/respond`

### Modified Files

4. **`dashboard/src/App.tsx`** (lines 1-229)
   - Add tab navigation (Sessions | Workflows) above the main content area
   - When "Workflows" tab is active, render `WorkflowList` + detail panel instead of `SessionList` + `MessageFeed`
   - Keep existing session view untouched under "Sessions" tab

5. **`dashboard/src/api.ts`** (lines 128-169)
   - Add `approvals()` method to fetch pending approvals: `GET /approvals`
   - Add `respondToApproval(id, decision, reason?)` method: `POST /approvals/:id/respond`
   - Add `WorkflowApproval` interface

## Implementation Approach

### Step 1: API Client Extensions (`api.ts`)

Add missing API methods and types:

```typescript
export interface WorkflowApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
  requestedBy?: string;
  createdAt: string;
}

// Add to api object:
approvals: () => req<{ approvals: WorkflowApproval[] }>("/approvals"),
respondToApproval: (id: string, decision: "approved" | "rejected", reason?: string) =>
  req<{ status: string }>(`/approvals/${id}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, reason }),
  }),
```

### Step 2: WorkflowPipeline Component

Build a horizontal phase pipeline that takes a `WorkflowRun` and renders each phase as a node in a connected chain:

- Parse the workflow's known phases from `phaseHistory` + `currentPhase`
- Use the canonical phase order: `["phase_0", "guardrails", "architect", "executor", "reviewer", "pr", "complete"]`
- For each phase, determine status:
  - In `phaseHistory` with `success: true` → completed (green)
  - In `phaseHistory` with `success: false` → failed (red)
  - Equals `currentPhase` and workflow status is `running` → active (blue pulse)
  - Equals `currentPhase` and workflow status is `paused` → paused (yellow)
  - Not yet reached → pending (gray)
- Show connecting lines/arrows between phase nodes
- Display timestamps and duration for completed phases
- Skip `phase_0` in visual display (it's just context loading)

### Step 3: ApprovalBanner Component

- Fetch pending approvals on interval
- Match approvals to workflow runs by `workflowRunId`
- Show inline in the workflow detail view with approve/reject actions
- On action, call API and refresh workflow runs list

### Step 4: WorkflowList Component

- Fetch workflow runs with `api.workflowRuns({ limit: 20 })` every 5 seconds
- Display as a list with:
  - Status indicator (colored dot or badge)
  - Workflow name + repo + issue number
  - Current phase name
  - Time started / elapsed / finished
  - Cancel button (for running/paused)
- Click a run to show its `WorkflowPipeline` in a detail panel

### Step 5: App.tsx Tab Integration

- Add a `tab` state: `"sessions" | "workflows"`
- Render tab bar below `StatsHeader`
- Conditionally render either the existing session view or the new workflow view
- Preserve all existing session functionality unchanged

### Step 6: Styling

- Use DaisyUI components (badges, cards, buttons, tabs) for consistency with existing dashboard
- Use Tailwind utilities for the pipeline layout
- Use Lucide React icons for phase status indicators (matching existing icon library)

## Risks and Edge Cases

1. **Empty state**: No workflow runs yet — show a helpful empty state message
2. **Long-running workflows**: Ensure auto-refresh doesn't cause flicker; use polling with state diffing
3. **Phase names may vary**: Different workflow definitions (build.yaml, pr-fix.yaml) have different phases — derive from the actual `phaseHistory` data rather than hardcoding
4. **DAG workflows**: `parallel-review.yaml` has parallel phases with `depends_on` — the pipeline visualization should handle branching (render parallel nodes side-by-side). This is a stretch goal; linear display is acceptable for v1.
5. **Approval race conditions**: Two admins could approve simultaneously — the API already handles this (returns error if already responded)
6. **Auth**: Approval actions go through the same auth middleware as other admin API calls — no additional auth needed

## Test Strategy

1. **Type safety**: TypeScript compilation (`npm run build` in dashboard/) ensures API types match
2. **Component rendering**: Manual testing via the dashboard with:
   - A running workflow (verify live phase progression)
   - A paused workflow at approval gate (verify approve/reject buttons work)
   - A completed workflow (verify all phases show green)
   - A failed workflow (verify failure indication)
   - No workflows (verify empty state)
3. **API integration**: Existing API endpoints have server-side tests; dashboard tests are manual
4. **Build verification**: `cd dashboard && npm run build` must succeed with no TypeScript errors

## Estimated Complexity

**Medium** — The backend API and data model are already complete. This is purely a frontend feature requiring 3 new React components, minor API client additions, and tab navigation in the existing App shell. The phase pipeline visualization is the most complex piece but can be built with Tailwind/DaisyUI without external charting libraries.
