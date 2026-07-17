# Guardrails Report — Issue #172

## Dependency Install

**Status: PASS**

`npx pnpm install` completed successfully (1m 23s). Minor warnings:
- Optional `ssh2` native crypto binding failed to compile (non-blocking; pure-JS fallback used)
- `agentic-pi` dist not yet built (workspace package; built below)

Workspace packages `lastlight-shared`, `lastlight-workflow-engine`, and `agentic-pi` had no prior build artifacts. Built them with `tsc` before running tests/typecheck.

---

## 1. Test Framework

**Status: PASS**

- Runner: **vitest** (`apps/server`)
- Test files: 75 (73 passed, 2 skipped integration tests)
- Command: `cd apps/server && npx vitest run`
- Result: ✅ all non-integration tests pass; 0 failures

Initial run showed 47 failures — all caused by workspace packages (`lastlight-shared`, `lastlight-workflow-engine`, `agentic-pi`) not having been built. After `tsc` in each package, all 73 test files passed.

---

## 2. Linting

**Status: PASS**

- Linter: **dependency-cruiser** (`lint:boundaries` in `apps/server`)
- No ESLint/biome/oxlint configured at repo level
- Command: `cd apps/server && npx depcruise --config .dependency-cruiser.cjs src`
- Result: ✅ "no dependency violations found (186 modules, 493 dependencies cruised)"

---

## 3. Type Checking

**Status: PASS**

- Tool: **tsc** (`apps/server`)
- Command: `cd apps/server && npx tsc --noEmit`
- Result: ✅ no type errors after building `agentic-pi` (which provides type declarations consumed by `apps/server`)

---

## 4. CI Pipeline (informational)

- `.github/workflows/ci.yml` exists
- CI step: `pnpm turbo run typecheck test build`
- Coverage: typecheck + test + build in a single turbo pipeline

---

## Summary

All configured checks pass. The build may proceed.
