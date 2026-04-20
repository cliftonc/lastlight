# Executor Summary — Issue #37

## What was done

Implemented security hardening across 7 files per the architect's plan, with one documented deviation for the Dockerfile changes.

### Files changed

| File | Change |
|---|---|
| `src/workflows/loop-eval.ts` | Added `Object.prototype.hasOwnProperty.call` guard in `readPath` before traversal |
| `src/workflows/runner.ts` | Added `validateShellCommand` helper; called before both `execSync` invocations; wrapped `new RegExp` in try/catch with length limit (200 chars) and nested quantifier rejection |
| `dashboard/src/components/timeline/CodeBlock.tsx` | Imported DOMPurify; wrapped `ansiConverter.toHtml` output with `DOMPurify.sanitize(..., { ADD_ATTR: ["style"] })` |
| `dashboard/src/components/timeline/ToolPair.tsx` | Same DOMPurify import and sanitize wrapping for inline ANSI preview |
| `package.json` | Bumped `@hono/node-server` to `^1.19.13`, `hono` to `^4.12.14` |
| `dashboard/package.json` | Bumped `dompurify` to `^3.3.4` |
| `src/workflows/loop-eval.test.ts` | Added 3 tests for prototype chain guard (`__proto__`, `constructor`, `prototype`) |
| `src/workflows/runner.test.ts` | Added 1 test verifying `until_bash` with `{{` is rejected (execSync not called with template marker) |

### Deviation: Dockerfiles not changed

Both `Dockerfile` and `sandbox.Dockerfile` end with `USER root`. The architect's risk analysis (items 1 and 2) identifies that both entrypoints (`deploy/entrypoint.sh`, `deploy/sandbox-entrypoint.sh`) start as root to perform `chown`, `chmod`, and `gosu` operations before dropping to the runtime user. Changing the final `USER` directive would break entrypoint functionality. The processes actually run as `lastlight`/`agent` at runtime via `exec gosu <user> "$@"`. This is an accepted risk — documented here.

## Test results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  19 passed (19)
      Tests  342 passed | 1 todo (343)
   Start at  21:58:38
   Duration  2.82s (transform 436ms, setup 0ms, import 757ms, tests 324ms, environment 1ms)
```

338 original tests + 4 new tests = 342 total, all passing.

## Lint results

No linter configured (see guardrails report — NOT CONFIGURED, non-blocking).

## Typecheck results

```
npx tsc --noEmit   → exit 0, no errors
cd dashboard && npx tsc -b  → exit 0, no errors
```

## Known issues / notes

- `axios` was listed in the architect plan for a version bump but is not present in `package.json` dependencies — no change needed.
- The nested quantifier ReDoS heuristic (`/(\([^)]*[+*][^)]*\))[+*?]/`) catches the most common catastrophic patterns. A full ReDoS analysis would require a dedicated safe-regex library; this is a reasonable first guard.
- DOMPurify `ADD_ATTR: ["style"]` preserves inline styles produced by ansi-to-html so ANSI colour rendering continues to work correctly.
