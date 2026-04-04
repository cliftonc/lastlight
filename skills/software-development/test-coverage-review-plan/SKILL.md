---
name: test-coverage-review-plan
description: Review a repository's automated test coverage, identify gaps, and produce a prioritized improvement plan even when formal coverage tooling is broken or unavailable.
version: 1.0.0
author: Sustain Bot
license: MIT
metadata:
  hermes:
    tags: [testing, coverage, vitest, planning, code-review]
    related_skills: [writing-plans, codebase-inspection, test-driven-development]
---

# Test Coverage Review and Improvement Planning

Use this when asked to assess a repo's current test coverage and propose a plan to improve it.

## When to use

- User asks "review test coverage"
- User wants a gap analysis of existing tests
- User wants a prioritized plan for new tests
- Coverage tooling may or may not already be configured

## Goal

Produce a practical answer with:
1. current test health
2. current coverage or a reasonable proxy
3. major untested / risky areas
4. a phased, prioritized improvement plan

## Workflow

### 1. Load relevant planning/context skills
If the output should include an implementation plan, also load `writing-plans`.

### 2. Inspect the repo and test setup
Check:
- `package.json` or equivalent test scripts
- test runner config (`vitest.config.*`, `jest.config.*`, `pytest.ini`, etc.)
- test file layout
- source tree size and major modules

For JS/TS repos, look for:
- `scripts.test`
- `vitest.config.ts` or `jest.config.*`
- `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`

### 3. Run the existing tests first
Always run the test suite before talking about coverage.

Capture:
- pass/fail counts
- failing files
- infrastructure/runtime errors
- warnings that affect trustworthiness

Important: if tests are red, report that the suite itself is a blocker to trustworthy coverage work.

### 4. Try real coverage reporting
If the repo uses Vitest and no coverage provider is installed:
- install `@vitest/coverage-v8` **matching the Vitest version exactly**
- then run coverage

Example:
```bash
npm test
npm install -D @vitest/coverage-v8@<exact-vitest-version> --legacy-peer-deps
npx vitest run --coverage
```

Pitfall discovered:
- Installing a mismatched `@vitest/coverage-v8` version can fail with errors like:
  - `The requested module 'vitest/node' does not provide an export named 'BaseCoverageProvider'`
- Fix by pinning `@vitest/coverage-v8` to the exact Vitest version in `package.json`.

### 5. If formal coverage fails, use a fallback heuristic
When coverage reports cannot be produced reliably, estimate coverage breadth by mapping tests to directly imported source files.

Useful fallback method:
- enumerate source files under `src/`
- enumerate test files
- parse relative `from '../src/...` imports in tests
- compute:
  - number of source files directly exercised by tests
  - ratio of directly imported source files to total source files
  - largest untested files by line count

This does **not** replace line/branch coverage, but it is a useful planning proxy.

### 6. Rank gaps by risk, not just size
Prioritize untested files using:
1. auth / security flows
2. data mutation / destructive operations
3. integration boundaries / external calls
4. core product workflows
5. large, complex files
6. pure helpers / lower-risk utilities

Good signals for high priority:
- auth/session management
- compiler/runtime worker logic
- RBAC/visibility logic
- integration/webhook providers
- file generation / AI-assisted workflows

### 7. Separate blockers from backlog
Organize findings into:
- **Immediate blockers**: broken tests, runtime incompatibilities, missing coverage setup
- **Phase 1**: highest-value new tests
- **Phase 2+**: broader coverage expansion

This keeps the plan realistic.

### 8. Save the plan in-repo when useful
If working locally, write a plan file such as:
- `docs/plans/YYYY-MM-DD-test-coverage-plan.md`

Include:
- current test counts/status
- blocker findings
- strong coverage areas
- largest/high-risk untested files
- phased recommendations
- best next slice

## Recommended output structure

Use this response shape:

```markdown
## Coverage review
- test runner
- test counts
- pass/fail status
- coverage availability / proxy used

## Immediate blocker(s)
- broken suite items
- tool/runtime incompatibilities

## Areas already covered well
- strongest tested modules

## Biggest gaps
- largest/high-risk untested files

## Prioritized plan
### P0
### P1
### P2

## Best next slice
- 3-5 concrete next steps
```

## JS/TS-specific notes

### Vitest coverage
- Coverage may require explicit installation of `@vitest/coverage-v8`.
- Match the package version to `vitest` exactly.

### Worker/runtime failures
If a test fails because a worker thread loads a `.ts` file directly, call that out explicitly as a trustworthiness blocker for the suite. This is especially important for compiler, sandbox, and background-worker code.

## Deliverable quality bar
A good coverage review should tell the user:
- what is tested
- what is not
- what is broken
- what should be tested next
- why that order is the right order
