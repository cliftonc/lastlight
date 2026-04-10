# Reviewer Verdict — Issue #6

VERDICT: REQUEST_CHANGES

## Summary

The generic loop implementation is largely correct and well-structured. All 166 tests pass and TypeScript compiles cleanly. One important bug is present: `execSync` for `until_bash` runs without a `cwd`, so it executes in the server process's working directory rather than the sandbox repo clone — making the canonical TDD use case (`until_bash: "npm test"`) non-functional in production. Additionally, the `!=` expression evaluator silently returns `true` for absent variables (due to `undefined !== 'value'`), which can cause premature loop termination.

## Issues

### Critical

None.

### Important

**1. `until_bash` missing `cwd` — runs in wrong directory (`src/workflows/runner.ts:503`)**

The architect plan explicitly specified "Execute `until_bash` command via `child_process.execSync` in the sandbox working directory". The implementation omits `cwd`:

```typescript
// Current (line 503):
execSync(loop.until_bash, { timeout: 30_000, stdio: "pipe" });

// Fix — use config.sandboxDir or config.cwd:
execSync(loop.until_bash, {
  timeout: 30_000,
  stdio: "pipe",
  cwd: config.sandboxDir ?? config.cwd,
});
```

The `ExecutorConfig` (passed as `config` to `runWorkflow`) already has `sandboxDir?: string` and `cwd?: string`. No signature change is needed — `config` is already in scope at the call site.

The example workflow `workflows/examples/tdd-loop.yaml` uses `until_bash: "npm test"`. Without the correct `cwd`, this command would not find the test project's `package.json` and would either fail or run against the wrong repo.

**2. `!=` evaluator returns `true` for absent context variables (`src/workflows/loop-eval.ts:42`)**

`ctx[key] !== value` evaluates to `true` when `key` is absent (because `undefined !== 'value'`). This can cause `verdict != 'FAILED'` to terminate the loop on the first iteration if `verdict` is not yet populated in context.

```typescript
// Current (line 41–43):
const [, key, value] = neqMatch;
return ctx[key] !== value;

// Fix:
const [, key, value] = neqMatch;
if (!(key in ctx)) return false; // absent variable — safe default
return ctx[key] !== value;
```

This is inconsistent with the `==` evaluator which correctly returns `false` for absent keys (since `undefined === 'value'` is already `false`).

### Suggestions

**3. `until` + `until_bash` combined semantics are OR, not AND (`src/workflows/runner.ts:501`)**

The plan says "If both conditions pass (or whichever is configured)" which reads as AND semantics when both are present. The implementation short-circuits: if `until` expression is true, `until_bash` is never evaluated. This is OR semantics. Both behaviours are reasonable, but the decision should be documented, and ideally tested with a test case covering both fields configured simultaneously.

**4. No test covers absent-variable `!=` edge case (`src/workflows/loop-eval.test.ts`)**

Add a test alongside the existing absent-variable `==` test:
```typescript
it("returns false when variable is absent from context", () => {
  expect(evalUntilExpression("missing != 'value'", { output: "" })).toBe(false);
});
```

### Nits

**5. `persistPhase` not called for max-iterations exhaustion path**

When the loop exhausts `max_iterations` without the condition being met (line 549–553), `persistPhase` is not called for the final iteration. This is inconsistent with the condition-met path (line 512) which does call `persistPhase`. The inconsistency is minor since the iteration label was already tracked on line 546, but could cause confusing DB state if the last iteration is also the one that exhausted the limit.

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  9 passed (9)
      Tests  166 passed (166)
   Start at  10:44:28
   Duration  1.74s (transform 262ms, setup 0ms, import 471ms, tests 216ms, environment 1ms)
```

TypeScript: `npx tsc --noEmit` — 0 errors.

## Re-review after Fix Cycle 1

VERDICT: APPROVED

Both Important issues are resolved. The `execSync` call at `src/workflows/runner.ts:501` now passes `cwd: config.sandboxDir ?? config.cwd`, matching the architect's spec. The `!=` evaluator at `src/workflows/loop-eval.ts:42` now returns `false` for absent context variables via the `if (!(key in ctx)) return false` guard, consistent with the `==` evaluator. A new test covering the absent-variable `!=` case was added (`src/workflows/loop-eval.test.ts`), bringing the total to 167 passing tests. The two open suggestions (OR/AND semantics documentation, `persistPhase` on exhaustion path) were not addressed, but both were non-blocking and remain acceptable as follow-up work.
