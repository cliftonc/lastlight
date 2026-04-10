# Architect Plan — Issue #10: Configure Test Framework

## Problem Statement

The repository has zero test infrastructure: no test runner, no test dependencies, no test scripts, and no test files (`package.json:1-37`). The guardrails report (`.lastlight/issue-10/guardrails-report.md:6-11`) marks this as a **blocking** issue. The codebase has several modules with pure, deterministic logic that are ideal initial test targets — particularly `src/engine/router.ts` (event routing), `src/managed-repos.ts` (repo allowlist), `src/config.ts` (config loading/model resolution), and `src/connectors/slack/mrkdwn.ts` (Markdown→Slack conversion).

## Summary

Install Vitest as the test framework, configure it for the project's ESM + TypeScript setup, add a `test` script to `package.json`, and write an initial test suite covering the most testable pure-logic modules. This gives the project a working test foundation that CI (a separate issue) can build on.

## Files to Modify

### 1. `package.json` (lines 10-19, 30-36)
- Add `vitest` to `devDependencies`
- Add `"test": "vitest run"` and `"test:watch": "vitest"` scripts

### 2. `vitest.config.ts` (NEW)
- Create Vitest config with ESM + TypeScript support
- Set `include` to `src/**/*.test.ts`
- No special transforms needed — Vitest handles TS natively

### 3. `tsconfig.json` (line 8)
- Ensure `"types": ["vitest/globals"]` if using global APIs (optional — prefer explicit imports)
- No changes needed if using explicit `import { describe, it, expect } from 'vitest'`

### 4. `src/engine/router.test.ts` (NEW) — ~20 tests
- Test all `routeEvent()` branches:
  - `issue.opened` → routes to `issue-triage`
  - `issue.reopened` → routes to `issue-triage` with `reopened: true`
  - `pr.opened` → routes to `pr-review`
  - `comment.created` without bot mention → `ignore`
  - `comment.created` with bot mention, non-maintainer → `polite-decline`
  - `comment.created` with bot mention, maintainer, build intent, on issue → `github-orchestrator`
  - `comment.created` with bot mention, maintainer, action intent, on issue → `issue-comment`
  - `comment.created` with bot mention, maintainer, build intent, on PR → `pr-fix`
  - `comment.created` with bot mention, maintainer, action intent, on PR → `issue-comment`
  - `message` with `/build` command (managed repo) → `github-orchestrator`
  - `message` with `/build` command (unmanaged repo) → `reply` with error
  - `message` with `/triage` command → `issue-triage`
  - `message` with `/review` command → `pr-review`
  - `message` with `/status` → `status-report`
  - `message` with `/new` or `/reset` → `chat-reset`
  - `message` with plain text → `chat`
  - Unknown event type → `ignore`
- Mock `classifyComment` from `src/engine/classifier.ts` (it calls an LLM) using `vi.mock()`

### 5. `src/managed-repos.test.ts` (NEW) — ~5 tests
- `isManagedRepo("cliftonc/drizzle-cube")` → `true`
- `isManagedRepo("unknown/repo")` → `false`
- `isManagedRepo(undefined)` → `false`
- `isManagedRepo(null)` → `false`
- `isManagedRepo("")` → `false`
- `MANAGED_REPOS` contains expected repos

### 6. `src/config.test.ts` (NEW) — ~8 tests
- `resolveModel()` returns per-type override when present
- `resolveModel()` falls back to default when no override
- `loadConfig()` reads env vars correctly (mock `process.env`)
- `parseModelConfig()` handles valid JSON, invalid JSON, missing env
- `loadConfig()` returns correct defaults when no env vars set

### 7. `src/connectors/slack/mrkdwn.test.ts` (NEW) — ~10 tests
- Headers → bold
- Bold `**text**` → `*text*`
- Strikethrough `~~text~~` → `~text~`
- Links `[text](url)` → `<url|text>`
- Images `![alt](url)` → `<url|alt>`
- Horizontal rules → `———`
- Code blocks preserved (not transformed)
- Inline code preserved
- Combined transformations

## Implementation Approach

### Step 1: Install Vitest
```bash
npm install -D vitest
```

### Step 2: Create `vitest.config.ts`
Minimal config — Vitest infers most settings from `tsconfig.json`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
```

### Step 3: Add npm scripts
Add `"test": "vitest run"` and `"test:watch": "vitest"` to `package.json` scripts.

### Step 4: Write test files
Create the four test files listed above. Start with `managed-repos.test.ts` (simplest, validates the setup works), then `mrkdwn.test.ts`, `config.test.ts`, and finally `router.test.ts` (most complex, requires mocking).

### Step 5: Verify
Run `npm test` and ensure all tests pass. Run `npm run build` and ensure test files don't break the TypeScript build (they shouldn't — `tsconfig.json` includes `src/**/*`).

## Risks and Edge Cases

1. **Module mocking with ESM**: Vitest's `vi.mock()` works with ESM but requires the mock to be hoisted. The `classifyComment` mock in router tests must use `vi.mock('../classifier.js', ...)` with the `.js` extension matching the import in `router.ts`. This is a known pattern and well-supported.

2. **`tsconfig.json` include**: Test files (`*.test.ts`) are under `src/` so they'll be included in the TypeScript compilation. This is fine for dev but means test files ship in `dist/`. If this becomes an issue later, a `tsconfig.build.json` can exclude them. Not blocking for now.

3. **`package.json` workspaces**: The `dashboard` workspace has its own dependencies. `npm install -D vitest` at root level should work fine — Vitest doesn't conflict with the dashboard's Vite setup.

4. **Config tests and process.env**: Tests that manipulate `process.env` must save/restore values to avoid leaking between tests. Use `beforeEach`/`afterEach` or Vitest's `vi.stubEnv()`.

5. **Router tests and async mocking**: `routeEvent` is async (calls `classifyComment`). The mock must return a resolved promise. Straightforward with `vi.fn().mockResolvedValue()`.

## Test Strategy

- **Unit tests only** for this initial suite — no integration tests, no network calls, no database
- All external dependencies (LLM classifier, file system for config) are mocked
- Tests colocated with source files (`*.test.ts` next to `*.ts`)
- Target: ~43 tests across 4 files, all passing, covering the core pure-logic modules
- Future work: integration tests for the engine, webhook handler, and state/db layer

## Estimated Complexity

**Simple** — This is a well-defined infrastructure task. Vitest requires minimal configuration for a standard ESM + TypeScript project. The test targets are pure functions with clear inputs and outputs. The only non-trivial part is mocking the classifier in router tests, which is a standard Vitest pattern.
