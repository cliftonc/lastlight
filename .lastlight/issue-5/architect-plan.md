# Architect Plan — Issue #5: YAML Workflow Definitions

## Problem Statement

The build cycle in `src/engine/orchestrator.ts` (1047 lines) has hardcoded phase ordering (`PHASE_ORDER` at line 86), prompt templates (lines 662-965), approval gate logic (lines 412-437, 554-578), and phase execution flow (lines 171-650). Cron jobs in `src/cron/jobs.ts:11-41` and router skill mappings in `src/engine/router.ts:30-283` are also static. Adding a new workflow (e.g., a "hotfix" cycle that skips architect, or a "docs-only" cycle) requires editing TypeScript, recompiling, and redeploying. This makes the system rigid and hard for non-developers to customize.

The goal is to extract workflow definitions into YAML files so that:
1. Workflows (build cycle, triage, review, health) are data, not code
2. New workflows can be added by dropping a YAML file — no recompile
3. Prompt templates are externalized and composable
4. Phase ordering, approval gates, and model overrides are declarative

## Summary of What Needs to Change

1. **New: YAML workflow schema and loader** — define a schema for workflow YAML files, load and validate them at startup
2. **New: Workflow YAML files** — extract the build cycle, cron jobs, and other workflows into `workflows/` directory
3. **New: Prompt template files** — extract prompt builder functions into template files with variable interpolation
4. **Refactor: Orchestrator** — replace hardcoded phase logic with a generic workflow runner that interprets YAML definitions
5. **Refactor: Cron jobs** — load cron definitions from YAML instead of `jobs.ts`
6. **Preserve: All existing behavior** — this is a refactor, not a feature change; all tests must continue to pass

## Files to Modify

### New Files

1. **`src/workflows/schema.ts`** — TypeScript interfaces for the YAML workflow schema + Zod validation
2. **`src/workflows/loader.ts`** — Load, validate, and cache YAML workflow files from `workflows/` directory
3. **`src/workflows/runner.ts`** — Generic phase runner that interprets a workflow definition (extracted from orchestrator.ts:113-169 `runPhase` and lines 171-650 `runBuildCycle`)
4. **`src/workflows/templates.ts`** — Template engine for prompt interpolation (replaces orchestrator.ts:662-965 prompt builders)
5. **`workflows/build.yaml`** — The build cycle workflow (extracted from orchestrator.ts)
6. **`workflows/pr-fix.yaml`** — PR fix workflow (extracted from orchestrator.ts:969-1047)
7. **`workflows/cron-triage.yaml`** — Triage cron job (from jobs.ts:17-22)
8. **`workflows/cron-review.yaml`** — PR review cron job (from jobs.ts:23-28)
9. **`workflows/cron-health.yaml`** — Health report cron job (from jobs.ts:33-38)
10. **`workflows/prompts/`** — Directory of prompt template files (one per phase: `guardrails.md`, `architect.md`, `executor.md`, `reviewer.md`, `re-reviewer.md`, `fix.md`, `pr.md`, `pr-fix.md`, `resume-check.md`)

### Modified Files

11. **`src/engine/orchestrator.ts`** — Slim down to a thin wrapper that loads the `build.yaml` workflow and delegates to the generic runner. Keep `BuildRequest`, `PrFixRequest`, and `ApprovalGateConfig` interfaces. Remove all `build*Prompt` functions and inline phase logic.
12. **`src/cron/jobs.ts`** — Replace hardcoded job list with loader that reads `workflows/cron-*.yaml`
13. **`src/config.ts`** — Add `workflowDir` config option (default: `./workflows`)
14. **`package.json`** — Add `yaml` dependency (e.g., `yaml` npm package)

### Test Files (New)

15. **`src/workflows/loader.test.ts`** — Tests for YAML loading and validation
16. **`src/workflows/runner.test.ts`** — Tests for generic workflow execution
17. **`src/workflows/templates.test.ts`** — Tests for prompt template interpolation

## Implementation Approach

### Step 1: Define the YAML schema (`src/workflows/schema.ts`)

Design the workflow definition interface:

```yaml
# workflows/build.yaml
name: build
description: "Architect -> Executor -> Reviewer build cycle"
trigger: build  # matched by router skill name

variables:
  branch: "lastlight/{{issueNumber}}-{{slugify issueTitle}}"
  taskId: "{{repo}}-{{issueNumber}}"
  issueDir: ".lastlight/issue-{{issueNumber}}"

phases:
  - name: phase_0
    type: context  # no agent execution, just context assembly

  - name: guardrails
    prompt: prompts/guardrails.md
    model: "{{models.guardrails}}"
    on_output:
      contains_BLOCKED:
        action: fail
        message: "Guardrails check: BLOCKED"
        unless_label: "lastlight:bootstrap"  # bootstrap tasks bypass block
      contains_READY:
        action: continue

  - name: architect
    prompt: prompts/architect.md
    model: "{{models.architect}}"
    approval_gate: post_architect  # optional, controlled by config

  - name: executor
    prompt: prompts/executor.md
    model: "{{models.executor}}"

  - name: reviewer
    prompt: prompts/reviewer.md
    model: "{{models.reviewer}}"
    loop:
      max_cycles: 2
      on_request_changes:
        fix_prompt: prompts/fix.md
        fix_model: "{{models.fix}}"
        re_review_prompt: prompts/re-reviewer.md
      approval_gate: post_reviewer  # optional

  - name: pr
    prompt: prompts/pr.md
    model: "{{models.pr}}"
    on_success:
      set_phase: complete
```

Use Zod for runtime validation of the parsed YAML against the schema.

### Step 2: Build the template engine (`src/workflows/templates.ts`)

- Extract all `build*Prompt` functions from `orchestrator.ts:662-965` into `.md` template files under `workflows/prompts/`
- Implement simple Mustache-style `{{variable}}` interpolation (no external dependency needed — the templates are simple string substitution)
- Support a small set of built-in helpers: `{{slugify text}}`, `{{branchUrl file}}`
- Context object passed to templates: `{ owner, repo, issueNumber, issueTitle, issueBody, sender, branch, commentBody, fixCycle, ... }`

### Step 3: Build the workflow loader (`src/workflows/loader.ts`)

- At startup, scan `workflows/*.yaml` and parse with the `yaml` npm package
- Validate each against the Zod schema
- Cache parsed workflows in a `Map<string, WorkflowDefinition>`
- Expose `getWorkflow(name: string)` and `getCronWorkflows()` functions
- Support hot-reload (watch for file changes) as a future enhancement — not in initial scope

### Step 4: Build the generic runner (`src/workflows/runner.ts`)

- Extract the core loop from `runBuildCycle` (orchestrator.ts:171-650) into a generic `runWorkflow(definition, request, config, callbacks, db)` function
- The runner iterates over `definition.phases`, for each:
  1. Check `shouldRun` based on resume state
  2. Render the prompt template with context variables
  3. Call `runPhase` (keep existing function from orchestrator.ts:113-169)
  4. Evaluate `on_output` rules to decide continue/fail/pause
  5. Handle `loop` phases (reviewer fix loop)
  6. Handle `approval_gate` pauses
- The runner is workflow-agnostic — it doesn't know about "architect" or "reviewer" specifically

### Step 5: Refactor the orchestrator (`src/engine/orchestrator.ts`)

- Keep: `BuildRequest`, `PrFixRequest`, `ApprovalGateConfig` interfaces, `runBuildCycle` and `runPrFix` as public API entry points
- `runBuildCycle` becomes: load `build.yaml`, build context, call `runWorkflow`
- `runPrFix` becomes: load `pr-fix.yaml`, build context, call `runWorkflow`
- Delete: all `build*Prompt` functions (now in template files), inline phase logic (now in runner)
- Target: reduce orchestrator.ts from ~1047 lines to ~150-200 lines

### Step 6: Refactor cron jobs (`src/cron/jobs.ts`)

- Replace hardcoded job definitions with: load all `workflows/cron-*.yaml`, map to `CronJob[]`
- Each cron YAML defines: `name`, `schedule`, `skill`, `context`, `condition` (e.g., `unless: webhooksEnabled`)

### Step 7: Tests

- **loader.test.ts**: Valid YAML parses correctly, invalid YAML rejected, missing files handled
- **runner.test.ts**: Phases execute in order, resume skips completed phases, approval gates pause, output rules evaluated correctly, reviewer loop works
- **templates.test.ts**: Variable substitution, slugify helper, missing variables handled gracefully
- **Existing tests**: `router.test.ts` (95 tests) must continue passing unchanged — the router is not modified

### Step 8: Update config and package.json

- Add `yaml` to `package.json` dependencies
- Add `workflowDir` to `LastLightConfig` in `config.ts:52` (default: `resolve("workflows")`)

## Risks and Edge Cases

1. **Prompt fidelity** — The prompt templates are complex with conditional sections (e.g., PR fix prompt's CI section at orchestrator.ts:1019-1021). Template engine must support conditionals or the templates need to handle this with `{{#if}}` blocks. Risk: subtle prompt regression. Mitigation: snapshot tests comparing rendered prompts against current output.

2. **Resume logic coupling** — The resume/dedup logic (orchestrator.ts:196-293) is tightly coupled to `PHASE_ORDER` and phase naming. The generic runner must derive phase ordering from the YAML definition. Risk: resume breaks. Mitigation: test resume with each workflow.

3. **Reviewer loop complexity** — The reviewer loop (orchestrator.ts:486-610) has special semantics: re-review prompts, fix prompts, cycle counting, verdict parsing. This needs special handling in the runner, not just "iterate phases." Risk: over-generalization makes the runner more complex than the original. Mitigation: model the loop as a first-class concept in the schema (`loop` property on a phase).

4. **Verdict parsing** — The orchestrator's verdict parsing (orchestrator.ts:516-543) is critical and nuanced. This must remain as TypeScript logic, not YAML. The `on_output` rules in the schema should support `verdict_marker: "VERDICT: APPROVED"` pattern matching.

5. **Bootstrap task detection** — `isBootstrapTask` (orchestrator.ts:50-54) checks labels and title prefixes. This conditional bypass needs to be expressible in YAML (`unless_label` in the schema).

6. **Backward compatibility** — Existing `.lastlight/issue-N/status.md` files on branches use phase names. The YAML workflow must use the same phase names to maintain resume compatibility.

7. **YAML parsing errors at startup** — If a workflow YAML is malformed, the system must fail fast with a clear error, not silently skip workflows.

## Test Strategy

1. **Unit tests for loader**: Parse valid/invalid YAML, validate schema, handle missing files
2. **Unit tests for templates**: Interpolation, helpers, edge cases (missing vars, special chars)
3. **Unit tests for runner**: Mock `executeAgent`, verify phase ordering, resume, approval gates, reviewer loop, output evaluation
4. **Snapshot tests**: Render each prompt template and compare against the output of current `build*Prompt` functions — ensures zero regression in prompt content
5. **Integration test**: Full build cycle with mocked executor, verifying the YAML-driven flow produces identical callbacks/notifications as the current hardcoded flow
6. **Existing tests**: All 95 existing tests must pass unchanged

Run: `npm test`
Typecheck: `npx tsc --noEmit`

## Estimated Complexity

**Complex** — This touches the core orchestration engine (1047 lines), introduces a new subsystem (YAML workflows + template engine + generic runner), and requires careful prompt migration with zero regression. Estimated ~15 new/modified files, ~800-1000 lines of new code, ~800 lines removed from orchestrator.ts.
