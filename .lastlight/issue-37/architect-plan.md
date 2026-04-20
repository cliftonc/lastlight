# Architect Plan — Issue #37 (Security Scan 2026-04-20)

## Problem Statement

The automated security scan surfaced 4 High and 11 Medium findings. The High-severity items are: both Dockerfiles end with `USER root` (production `Dockerfile:20`, sandbox `sandbox.Dockerfile:25`), and two `execSync(loop.until_bash, …)` calls in `src/workflows/runner.ts:746` and `:1311` accept raw shell strings from YAML config with no guard against future template interpolation. The Medium findings are split between vulnerable dependencies (5 npm packages), a ReDoS-susceptible non-literal RegExp (`runner.ts:908`), a prototype-chain read in `src/workflows/loop-eval.ts:32`, and two `dangerouslySetInnerHTML` usages without DOMPurify in the dashboard (`CodeBlock.tsx:50`, `ToolPair.tsx:131`).

## Summary of Changes

1. **Dockerfiles** — switch final USER to non-root in both images.
2. **runner.ts** — add a comment/schema-level guard on `until_bash` and validate `unless_title_matches` regex safety at evaluation time.
3. **loop-eval.ts** — add prototype-chain guard to `readPath`.
4. **Dashboard** — wrap ANSI HTML output with DOMPurify in CodeBlock and ToolPair.
5. **Dependencies** — update `@hono/node-server`, `axios`, `hono`, `dompurify` (dashboard).

## Files to Modify

| # | File | Lines | Change |
|---|------|-------|--------|
| 1 | `Dockerfile` | 20 | Remove `USER root` after CLI install; move privileged steps before the switch; ensure final USER is `lastlight` before ENTRYPOINT |
| 2 | `sandbox.Dockerfile` | 25 | Move `USER root` before app setup; add final `USER agent` after all privileged steps (before ENTRYPOINT — entrypoint already uses `gosu` to drop) |
| 3 | `src/workflows/runner.ts` | 746, 1311 | Wrap `execSync` calls with a validation that rejects `until_bash` values containing template mustache patterns (`{{…}}`). Log a warning if triggered. |
| 4 | `src/workflows/runner.ts` | 908 | Wrap the `new RegExp(…)` in a try/catch; add a length limit (e.g. 200 chars) and reject patterns with known catastrophic backtracking markers (nested quantifiers). |
| 5 | `src/workflows/loop-eval.ts` | 31-32 | Guard with `Object.prototype.hasOwnProperty.call(cur, parts[i])` before traversing. Return `undefined` for prototype keys. |
| 6 | `dashboard/src/components/timeline/CodeBlock.tsx` | 50 | Import DOMPurify, wrap `ansiHtml` with `DOMPurify.sanitize()`. |
| 7 | `dashboard/src/components/timeline/ToolPair.tsx` | 131 | Import DOMPurify, wrap `ansiConverter.toHtml(preview)` with `DOMPurify.sanitize()`. |
| 8 | `package.json` | deps | Update `@hono/node-server` to `^1.19.13`, `axios` to `^1.15.0`, `hono` to `^4.12.14` |
| 9 | `dashboard/package.json` | deps | Update `dompurify` to `^3.3.4` |

## Implementation Approach

### Step 1: Dependency updates (items 5-9 from findings)
- Bump `@hono/node-server`, `axios`, `hono` in root `package.json`.
- Bump `dompurify` in `dashboard/package.json`.
- Run `npm update` for each and verify lock file changes.
- This addresses findings 5, 6, 7, 8, 9, 10 (and transitively 11 for follow-redirects).

### Step 2: Dockerfile hardening (findings 1, 2)
- `Dockerfile`: The entrypoint already uses `gosu lastlight` for runtime. Restructure so that all privileged `COPY`/`RUN` steps complete first, then switch to `USER lastlight` as the final directive. The entrypoint handles runtime privilege escalation for volume ownership via `gosu`.
- `sandbox.Dockerfile`: The entrypoint already drops to `agent` via `gosu`. Remove the final `USER root` after the Claude CLI install. Keep it as `USER root` only where needed for package installs, then end with `USER agent`. Since entrypoint runs as root and uses `gosu agent`, this Dockerfile change means the CMD default runs as agent — which is correct.

### Step 3: Code hardening — runner.ts (findings 3, 4, 12)
- Add a helper `validateShellCommand(cmd: string)` that throws if the string contains `{{` (template injection marker). Call it before both `execSync` invocations.
- For the ReDoS finding: wrap `new RegExp(rule.unless_title_matches, "i")` in a try/catch, add a max-length check (200 chars), and reject patterns with nested quantifiers via a simple heuristic regex `/([\+\*])\{0,\}.*\1/` or use a safe-regex check.

### Step 4: Code hardening — loop-eval.ts (finding 13)
- In `readPath`, before the bracket access, check `Object.prototype.hasOwnProperty.call(cur, parts[i])`. If false, return `undefined`. This prevents traversal into `__proto__`, `constructor`, or `prototype`.

### Step 5: Dashboard XSS hardening (findings 14, 15)
- In `CodeBlock.tsx`: import DOMPurify, wrap `ansiConverter.toHtml(code)` result with `DOMPurify.sanitize(…)`.
- In `ToolPair.tsx`: same pattern for the inline preview.
- The `dompurify` package is already a dashboard dependency — just needs the import and the sanitize call.

### Step 6: Verify
- `npx tsc --noEmit` (server)
- `cd dashboard && npx tsc -b` (dashboard)
- `npx vitest run` (tests)
- Manual review of Dockerfile build (if docker available)

## Risks and Edge Cases

1. **Dockerfile USER change**: The entrypoint `deploy/entrypoint.sh` already does `gosu lastlight` for the main process. Verify it doesn't rely on the image defaulting to root for any pre-flight steps. The `ENTRYPOINT` itself runs as root (since Docker runs the entrypoint as the image USER), so we may need to keep the entrypoint running as root and only change CMD context — review `entrypoint.sh` logic.
2. **sandbox.Dockerfile**: Entrypoint comment says "runs as root, fixes permissions, then drops to agent via gosu" — so the entrypoint expects to start as root. We should NOT change the final USER for sandbox since the entrypoint needs root. The finding is valid but the fix must be in the entrypoint design or documented as accepted risk. Alternative: keep `USER root` but ensure the CMD (`sleep infinity`) is run via `gosu agent` by the entrypoint (which it already is).
3. **until_bash validation**: Rejecting `{{` is a heuristic. If a legitimate shell command contains `{{` (e.g. bash brace expansion), it would be blocked. This is unlikely for `until_bash` use cases but should be documented.
4. **RegExp length limit**: A 200-char limit is arbitrary. Existing workflow YAML patterns should be audited to ensure none exceed it.
5. **DOMPurify + ansi-to-html**: DOMPurify may strip `<span style="…">` tags that ansi-to-html produces. Need to verify DOMPurify's default config allows inline styles, or use `ADD_ATTR: ['style']`.

## Test Strategy

- **Existing tests**: Run `npx vitest run` — 338 tests must continue to pass.
- **loop-eval.ts**: Add test case in `loop-eval.test.ts` for `__proto__` path traversal returning `undefined`.
- **runner.ts**: Add test case in `runner.test.ts` for `until_bash` containing `{{` being rejected (or skipped with warning).
- **Dashboard**: `cd dashboard && npx tsc -b` for type checking. Manual verification that ANSI rendering still works (DOMPurify preserves `<span style>`).
- **Dockerfiles**: Build both images and verify the process runs as the expected user (`docker run --rm <image> whoami`).
- **Dependencies**: `npm audit` after updates to confirm findings are resolved.

## Estimated Complexity

**Medium** — Multiple files across server, dashboard, and Docker configs. Each individual change is straightforward, but the breadth (9 files, 3 domains) and the need to verify Dockerfile entrypoint interactions add coordination overhead. No architectural changes required.
