# Architect Plan — Issue #6: Loop Nodes as a Workflow Primitive

## Problem Statement

The workflow runner (`src/workflows/runner.ts:237-412`) has a hardcoded reviewer-fix loop that only handles one pattern: run reviewer, parse `VERDICT:` marker, run fix if `REQUEST_CHANGES`, repeat. The loop schema (`src/workflows/schema.ts:19-28`) is tightly coupled to this reviewer pattern via `on_request_changes` with `fix_prompt` / `re_review_prompt`. Issue #6 requests a generic `loop` node type with configurable completion conditions (expression-based, bash-based), max iterations, optional human gates, and fresh-context resets — enabling reusable patterns like iterative refinement, TDD loops, and interactive exploration beyond just the fix-after-review case.

## Summary of Changes

1. **Extend the workflow schema** to support a generic `loop` phase type alongside the existing reviewer-specific loop
2. **Add a generic loop executor** in the runner that evaluates `until` expressions and `until_bash` commands
3. **Track loop iterations** as individual phase history entries in the DB
4. **Support interactive gates** between iterations
5. **Support fresh context resets** per iteration
6. **Preserve backward compatibility** — the existing `phase.loop` (reviewer-style) continues to work unchanged
7. **Add a sample loop workflow** to demonstrate the new primitive
8. **Add comprehensive tests** for the new loop node behavior

## Files to Modify

### 1. `src/workflows/schema.ts` — Add generic loop node schema

**Lines 17-28:** Add a new `GenericLoopSchema` alongside the existing `PhaseLoopSchema`.

```typescript
// New: generic loop configuration (lines after 28)
const GenericLoopSchema = z.object({
  max_iterations: z.number().int().positive(),
  until: z.string().optional(),            // expression: "reviewer.verdict == 'APPROVED'"
  until_bash: z.string().optional(),       // shell command: exit 0 = complete
  interactive: z.boolean().default(false), // pause for approval between iterations
  gate_message: z.string().optional(),     // message shown at interactive gate
  fresh_context: z.boolean().default(false), // reset agent session each iteration
});
```

**Lines 32-52:** Add `generic_loop` field to `PhaseDefinitionSchema`:

```typescript
generic_loop: GenericLoopSchema.optional(),
```

**Export** the new type: `GenericLoop`.

### 2. `src/workflows/runner.ts` — Add generic loop execution logic

**Lines 236-412:** After the existing `if (phase.loop)` block, add a new block:

```typescript
if (phase.generic_loop) {
  // Generic loop execution — see implementation approach below
}
```

Key additions:
- **Expression evaluator** (~15 lines): Parse simple `lhs == 'rhs'` expressions against a context map built from phase outputs. Support `output.contains('text')` and `output.exitcode == 0`.
- **Bash condition runner** (~10 lines): Execute `until_bash` command via `child_process.execSync` in the sandbox working directory; exit 0 = loop complete.
- **Iteration loop** (~60 lines): Main `while` loop that:
  1. Runs the phase agent
  2. Evaluates `until` expression and/or `until_bash` command
  3. If `interactive: true` and not yet complete, creates an approval gate
  4. If `fresh_context: true`, does not carry forward prior output in the prompt
  5. Tracks each iteration as `{phaseName}_iter_{N}` in phase history
  6. Respects `max_iterations` cap

**Lines 129-136:** Add `{phaseName}_iter_` prefix to `phaseIndex()` to map loop iterations to their parent phase for resume logic (similar to existing `fix_loop` mapping at line 133).

### 3. `src/workflows/templates.ts` — Add iteration context variables

**Lines 11-49:** Add to `TemplateContext`:

```typescript
// Optional: available during generic loop iterations
iteration?: number;        // current iteration (1-based)
maxIterations?: number;    // configured max
previousOutput?: string;   // output from prior iteration (unless fresh_context)
```

### 4. `src/state/db.ts` — No schema changes needed

The existing `phase_history` JSON array and `PhaseHistoryEntry` type (`db.ts:6-11`) already support arbitrary phase names. Loop iterations will be tracked as entries like `{ phase: "tdd-loop_iter_1", timestamp, success, summary }`. No DDL changes required.

### 5. `workflows/build.yaml` — No changes (backward compatible)

The existing reviewer loop at lines 30-39 uses `phase.loop` (the reviewer-specific schema) and continues to work unchanged. The new `generic_loop` field is separate and optional.

### 6. `workflows/examples/tdd-loop.yaml` — New example workflow

Create an example workflow demonstrating the TDD loop pattern:

```yaml
type: build
name: tdd-cycle
description: "Test-driven development loop"
phases:
  - name: phase_0
    type: context
  - name: write-test
    prompt: prompts/write-test.md
  - name: implement
    prompt: prompts/implement.md
    generic_loop:
      max_iterations: 5
      until_bash: "npm test"
      interactive: false
      fresh_context: false
```

### 7. `src/workflows/runner.test.ts` — Add loop node tests

Add new `describe` block after line 418:

```typescript
describe("runWorkflow — generic loop node", () => {
  // Test: completes on first iteration when until condition met
  // Test: iterates up to max_iterations
  // Test: until_bash exit 0 completes loop
  // Test: until_bash non-zero continues loop
  // Test: interactive mode pauses between iterations
  // Test: fresh_context does not carry forward output
  // Test: expression evaluation against output
});
```

## Implementation Approach

### Step 1: Schema extension (`schema.ts`)

1. Define `GenericLoopSchema` with all fields from the issue requirements
2. Add `generic_loop` to `PhaseDefinitionSchema` as optional
3. Export the new `GenericLoop` type
4. Validate that `until` and `until_bash` are not both absent (at least one completion condition required)

### Step 2: Expression evaluator (new file: `src/workflows/loop-eval.ts`)

Create a small, focused evaluator (~50 lines) that handles:
- `output.contains('text')` — check if phase output contains a string
- `variable == 'value'` — equality check against a context map
- `variable != 'value'` — inequality check
- The context map is populated from the current iteration's output and any named results from prior phases

This is deliberately limited to avoid the complexity and security risk of a general expression evaluator. Complex conditions should use `until_bash` instead.

### Step 3: Bash condition evaluator (in runner.ts)

- Use `child_process.execSync(command, { cwd, timeout: 30000 })`
- Exit 0 = condition met (loop complete)
- Non-zero = continue iterating
- Capture stderr for logging on failure
- Timeout at 30s to prevent hangs

### Step 4: Generic loop execution (runner.ts)

Add after the existing `if (phase.loop)` block at line 412:

```
if (phase.generic_loop) → handle generic loop
```

The loop body:
1. Initialize: `iteration = 0`, `complete = false`, `previousOutput = ""`
2. While `!complete && iteration < max_iterations`:
   a. Increment `iteration`
   b. Build prompt: render `phase.prompt` with `{ iteration, maxIterations, previousOutput }`
   c. If `fresh_context`: clear `previousOutput`
   d. Run phase via `runPhase()` with label `{phaseName}_iter_{iteration}`
   e. Check `until` expression (if present) against `{ output: result.output }`
   f. Check `until_bash` (if present) — run command, check exit code
   g. If both conditions pass (or whichever is configured): `complete = true`
   h. If `interactive` and `!complete`: create approval gate, pause, return
   i. Persist phase entry for this iteration
3. After loop: update context with `_loopCompleted` and `_iterations`

### Step 5: Resume support for generic loops

- In `phaseIndex()` (line 132-136): add mapping for `_iter_` prefix phases
- In `shouldRun()`: loop iteration phases (unknown to PHASE_ORDER) already return `true` via the `-1` fallback at line 211
- DB deduplication in `runPhase()` handles individual iteration labels naturally

### Step 6: Template context extension

Add `iteration`, `maxIterations`, `previousOutput` to `TemplateContext` interface so prompt templates can reference `{{iteration}}` and `{{previousOutput}}`.

### Step 7: Tests

- Mock `child_process.execSync` for `until_bash` tests
- Mock `executeAgent` outputs to test expression evaluation
- Test all loop termination conditions: expression, bash, max_iterations, interactive gate
- Test backward compatibility: existing reviewer loop tests still pass

## Risks and Edge Cases

1. **Expression injection**: The `until` expression evaluator must be sandboxed. Using a simple parser (not `eval()`) mitigates this. Only support a fixed set of operators.
2. **Bash command injection**: `until_bash` runs user-defined commands. This is acceptable because workflow YAML files are committed to the repo by maintainers (same trust level as CI). Apply a 30s timeout to prevent hangs.
3. **Infinite loops**: `max_iterations` is required and enforced. The schema validates it as a positive integer.
4. **Interactive gate + resume**: When an interactive gate pauses the workflow, the orchestrator must correctly resume into the loop's next iteration. The `phaseIndex` mapping and DB phase tracking handle this, but it needs thorough testing.
5. **Fresh context + large outputs**: If `fresh_context: false`, accumulated `previousOutput` could grow large over many iterations. Cap it at a reasonable size (e.g., last 10KB).
6. **Backward compatibility**: The existing `phase.loop` (reviewer-specific) and `phase.generic_loop` are separate fields. No existing workflows or code paths are affected.
7. **Stale containers**: The existing container deduplication (`isContainerAlive` check at runner.ts:43-50) applies per-iteration since each gets a unique label.

## Test Strategy

### Unit tests (runner.test.ts)
- Generic loop completes on first iteration (until expression true immediately)
- Generic loop iterates exactly N times before expression becomes true
- Generic loop stops at max_iterations even if condition not met
- `until_bash` exit 0 terminates loop; non-zero continues
- `interactive: true` pauses after each iteration, resumes correctly
- `fresh_context: true` does not pass previousOutput to subsequent iterations
- `fresh_context: false` (default) passes previousOutput
- Existing reviewer loop tests continue to pass unchanged

### Unit tests (loop-eval.test.ts)
- `output.contains('APPROVED')` with matching and non-matching output
- `verdict == 'APPROVED'` equality check
- `verdict != 'FAILED'` inequality check
- Invalid expressions return false (safe default)

### Integration test (manual)
- Create a `tdd-loop.yaml` workflow with `until_bash: "npm test"`
- Run against a repo with failing tests
- Verify iterations run, tests eventually pass, loop terminates

## Estimated Complexity

**Medium** — The schema and runner changes are well-scoped (the existing loop pattern provides a clear template), but the expression evaluator, interactive gate integration, and resume logic across iteration boundaries require careful implementation and testing. Approximately 200-300 new lines of production code and 150-200 lines of tests.
