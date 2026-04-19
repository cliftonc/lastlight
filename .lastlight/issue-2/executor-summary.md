# Executor Summary — Issue #2: Security Review

## What was done

Implemented the security scanning infrastructure as specified in the architect plan.

## Files changed

### New files
- `workflows/security-review.yaml` — health-kind workflow for security scans
- `workflows/cron-security.yaml` — cron trigger, Monday 10:00, deliverSlackSummary
- `workflows/security-feedback.yaml` — health-kind workflow for processing maintainer feedback
- `skills/security-review/SKILL.md` — full scan procedure (clone, SECURITY.md, npm audit, semgrep, gitleaks, Claude read-pass, normalize, filter, dedupe, file issues, summary)
- `skills/security-feedback/SKILL.md` — classify maintainer intent (accept-risk, false-positive, discuss, ignore, reopen), update SECURITY.md via PR

### Modified files
- `src/engine/classifier.ts` — added `"security"` to `CommentIntent` union, `SECURITY` category to prompt, example, `SECURITY: "security"` to intentMap
- `src/engine/router.ts` — added `@last-light security-review` structured match before LLM classification; added security-labeled issue routing to `security-feedback`; added `case "security"` in Slack intent switch
- `src/cli.ts` — added `"security"` to skill commands check and `security: "security-review"` to skillMap; repo-level only (no single-issue parsing)
- `src/workflows/runner.ts` — exported `gitAccessProfileForWorkflow`; added `case "security-review": return "issues-write"` and `case "security-feedback": return "repo-write"`
- `sandbox.Dockerfile` — added new RUN layer installing python3/pipx/semgrep and gitleaks v8.21.2 binary

### Test files modified
- `src/engine/router.test.ts` — added 9 new tests covering: `@last-light security-review` structured match, security-labeled issue routing to security-feedback, security Slack intent (managed/unmanaged/no-repo)
- `src/workflows/runner.test.ts` — added 3 tests for `gitAccessProfileForWorkflow` (security-review, security-feedback, unknown)
- `src/workflows/loader.test.ts` — added 3 tests verifying security-review, security-feedback, and cron-security YAMLs parse without errors

## Test results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  14 passed (14)
      Tests  289 passed | 1 todo (290)
   Start at  22:47:09
   Duration  2.37s (transform 376ms, setup 0ms, import 644ms, tests 328ms, environment 1ms)
```

14 new tests added, all passing. Zero failures. Zero skips (1 pre-existing todo).

## Lint results

No linter configured (noted as non-blocking in guardrails-report.md).

## Typecheck results

```
npx tsc --noEmit
(exit 0 — no output, no errors)
```

## Deviations from plan

None. All 8 steps from the architect plan were implemented as specified. The `gitAccessProfileForWorkflow` function was exported (not previously exported) to enable direct unit testing.

## Fix Cycle 1

### Issue fixed

**semgrep inaccessible to agent user at runtime** (`sandbox.Dockerfile:10-17`)

Changed `pipx install semgrep` to use `PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep` so the semgrep binary lands at `/usr/local/bin/semgrep` (world-executable) instead of `/root/.local/bin/semgrep` (behind the `700`-permission `/root` directory). Removed the `ENV PATH="/root/.local/bin:${PATH}"` line that was only needed for the old install path.

### Test results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  14 passed (14)
      Tests  289 passed | 1 todo (290)
   Start at  22:50:57
   Duration  2.48s (transform 404ms, setup 0ms, import 695ms, tests 315ms, environment 1ms)
```

### Lint results

No linter configured (non-blocking).

### Typecheck results

```
npx tsc --noEmit
(exit 0 — no output, no errors)
```
