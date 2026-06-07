# Guardrails report

Status: READY

## Guardrails Report: cliftonc/lastlight

### Test Framework
- Status: PRESENT
- Runner: vitest
- Command: `npm test`
- Evidence:
  - `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`
  - Test files present throughout `src/**/*.test.ts`
  - Execution: `npm test` ran successfully and executed 27 test files, 468 tests (467 passed, 1 todo).
- Notes: Test suite is fast and comprehensive; runner is fully usable even if future changes introduce failing tests.

### Linting
- Status: MISSING
- Tool: none detected
- Command: _n/a_
- Evidence:
  - `npm run lint` fails with: `npm error Missing script: "lint"`.
  - No eslint/biome config files surfaced in the root listing.
- Notes: No configured lint script; style and basic static checks will rely on reviewers and TypeScript for now.

### Type Checking
- Status: PRESENT (via build)
- Tool: TypeScript (`tsc`)
- Command: `npm run build`
- Evidence:
  - `tsconfig.json` present in repo root.
  - `package.json` script: `"build": "tsc"`.
  - No separate `"typecheck"` script; `npm run typecheck` fails with `Missing script: "typecheck"`.
- Notes: Use `npm run build` for type-checking (no `--noEmit` script defined). This is adequate for the build pipeline, though a dedicated `typecheck` script would be cleaner.

### CI Pipeline
- Status: PRESENT
- Evidence:
  - `.github/workflows/publish.yml` exists (at least one GitHub Actions workflow configured).
- Notes: The discovered workflow appears focused on publish; additional CI workflows for tests/lint may live elsewhere but were not required for this check.

### Summary of Commands for the Build Workflow
- Tests: `npm test`
- Lint: _none configured_ (do not attempt `npm run lint` — it fails)
- Type check: `npm run build` (no `npm run typecheck` script)

### Verdict: READY (with notes)
- Tests: working and comprehensive → OK.
- Type checking: available via `npm run build` → OK.
- Linting: not configured → non-blocking gap; callouts above for awareness.
