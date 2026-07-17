---
issue: 172
branch: lastlight/172-limit-in-process-workflows
current_phase: executor
---

# Status — #172 Limit in-process workflows

## architect (complete)
- Analyzed the dispatch funnel (`index.ts` `dispatchWorkflow` →
  `simple.ts` `runSimpleWorkflow`), the run-state store, resume/orphan
  machinery, config layering, and dashboard status rendering.
- Confirmed: `workflow_runs.status` is a free TEXT column (no CHECK), so
  `'queued'` needs no migration; resumes/orphan restarts bypass the fresh-run
  branch naturally (Option A comes for free).
- Wrote `architect-plan.md` — exhaustive manifest (14 file groups + tests),
  admission-via-`resumeSimpleRun` design, TTL sweep, config block, guardrail
  commands.

## Next: executor
Implement per the manifest, starting with the workflow-engine `WorkflowResult`
change (rebuild the package), then the store, config, gate, admission
controller, index wiring, dispatcher, and dashboard.
