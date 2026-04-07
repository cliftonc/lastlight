---
name: assure-guardrails
description: >
  Pre-flight check before implementation work. Verifies a repo has the foundational
  dev guardrails (test framework, linting, type checking) needed for the build cycle.
  Creates issues for missing guardrails and blocks implementation until they're resolved.
version: 1.0.0
author: Last Light
license: MIT
tags: [guardrails, pre-flight, testing, linting, quality, workflow]
related_skills: [architect, subagent-driven-development, test-driven-development, requesting-code-review]
---

# Assure Guardrails

## Purpose

The build cycle depends on foundational tooling: TDD needs a test framework, the
requesting-code-review pipeline needs linting and type checking, the Reviewer needs
tests to run. If any of these are missing, implementation work will either skip
quality checks or fail at verification.

This skill runs **after cloning a repo and reading its docs**, but **before the
Architect phase**. It ensures the foundations exist. If they don't, it creates
GitHub issues to add them and links those issues to the original task.

**Core principle:** You cannot build reliably on a repo without tests, linting, and
type checking. Fix the foundations first, then build features.

## When to Run

Run this check:
- Before any build request (Architect→Executor→Reviewer cycle)
- Before any test coverage analysis
- Before any planned implementation work on a managed repo
- Skip for: pure documentation changes, issue triage, PR reviews, health reports

## What to Check

After cloning the repo and reading `CLAUDE.md`/`AGENTS.md`, verify these guardrails:

### 1. Test Framework

**Check for:**
- Test runner config (`vitest.config.*`, `jest.config.*`, `pytest.ini`, `pyproject.toml [tool.pytest]`, `Cargo.toml [dev-dependencies]`, etc.)
- Test script in `package.json` (`scripts.test`) or equivalent
- At least one test file exists (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`)
- Tests actually run: execute the test command and confirm it doesn't error

**If missing:** The repo has no test framework. TDD is impossible. This is a blocker.

### 2. Linting

**Check for:**
- Linter config (`.eslintrc*`, `biome.json`, `.ruff.toml`, `ruff.toml`, `.flake8`, `clippy` in Cargo)
- Lint script in `package.json` (`scripts.lint`) or equivalent
- Linter actually runs without crashing

**If missing:** Code quality checks in the review pipeline will be skipped.

### 3. Type Checking

**Check for:**
- TypeScript: `tsconfig.json` and a typecheck script (`tsc --noEmit`)
- Python: `mypy.ini`, `pyproject.toml [tool.mypy]`, or `pyrightconfig.json`
- Rust: built-in (cargo check)
- Go: built-in (go vet)

**If missing:** Type errors won't be caught before merge.

### 4. CI Pipeline (informational, not blocking)

**Check for:**
- `.github/workflows/` with test/lint/typecheck steps
- Or equivalent CI config (`.gitlab-ci.yml`, `Jenkinsfile`, etc.)

**If missing:** Note it as a recommendation but don't block on it.

## Detection by Language

Use the repo's `CLAUDE.md` first — it often documents the exact commands. Fall back to
auto-detection only if docs don't cover it.

### JavaScript / TypeScript
```bash
# Test framework
cat package.json | grep -E '"test"'
ls vitest.config.* jest.config.* 2>/dev/null
find . -name '*.test.*' -o -name '*.spec.*' | head -5

# Linting
cat package.json | grep -E '"lint"'
ls .eslintrc* biome.json 2>/dev/null

# Type checking
ls tsconfig.json 2>/dev/null
cat package.json | grep -E '"typecheck"|"tsc"'
```

### Python
```bash
# Test framework
ls pytest.ini setup.cfg pyproject.toml 2>/dev/null
grep -l pytest pyproject.toml setup.cfg 2>/dev/null
find . -name 'test_*.py' -o -name '*_test.py' | head -5

# Linting
ls .ruff.toml ruff.toml .flake8 2>/dev/null

# Type checking
ls mypy.ini pyrightconfig.json 2>/dev/null
grep -l mypy pyproject.toml 2>/dev/null
```

### Rust
```bash
# Tests are built-in (cargo test)
grep '\[dev-dependencies\]' Cargo.toml
# Linting is built-in (cargo clippy)
# Type checking is built-in (cargo check)
```

## Output Format

Produce a guardrails report:

```markdown
## Guardrails Report: {repo}

### Test Framework
- Status: PRESENT / MISSING / BROKEN
- Runner: {vitest / jest / pytest / cargo test / ...}
- Command: {npm test / pytest / ...}
- Test count: {N tests found}
- Notes: {any issues}

### Linting
- Status: PRESENT / MISSING / BROKEN
- Tool: {biome / eslint / ruff / clippy / ...}
- Command: {npm run lint / ...}
- Notes: {any issues}

### Type Checking
- Status: PRESENT / MISSING / BROKEN
- Tool: {tsc / mypy / cargo check / ...}
- Command: {npm run typecheck / ...}
- Notes: {any issues}

### CI Pipeline
- Status: PRESENT / MISSING
- Notes: {what it covers}

### Verdict: READY / BLOCKED
```

## When Guardrails Are Missing

If any of tests, linting, or type checking are **MISSING** or **BROKEN**:

### 1. Create a guardrails issue

Use `mcp_github_create_issue` to create an issue in the target repo:

```
Title: Add missing dev guardrails: {list of missing items}

Labels: enhancement, p1-high

Body:
## Missing Guardrails

The following foundational tooling is missing or broken in this repo:

- [ ] {Test framework — no test runner configured}
- [ ] {Linting — no linter configured}
- [ ] {Type checking — no typecheck script}

## Why This Matters

These are prerequisites for reliable development:
- **Tests** are required for TDD and the verification pipeline
- **Linting** catches style and correctness issues before review
- **Type checking** catches type errors before merge

## Blocked Work

This issue blocks #{original_issue_number} — implementation work cannot
proceed reliably without these foundations.

## Suggested Setup

{Language-specific recommendations based on what the repo already uses}
```

### 2. Link to the original task

Post a comment on the original task issue:

```
Guardrails check found missing foundations in this repo:
- {list}

Created #{guardrails_issue_number} to add them. Implementation work on this
task should wait until the guardrails are in place, or proceed with the
understanding that quality verification will be limited.
```

### 3. Decide whether to proceed or block

**Block** (create guardrails first, then resume original task):
- No test framework at all — TDD is impossible
- Tests exist but are completely broken — verification is meaningless

**Proceed with warning** (note limitations in PR description):
- Linting missing — code quality review still works, just less automated
- Type checking missing — reviewer can still catch type issues manually
- CI missing — local verification still works

### 4. If blocking: run the guardrails fix as a build request

Treat the guardrails issue as a build request itself — run it through the
Architect→Executor→Reviewer cycle. Once the guardrails PR is merged, resume
the original task.

## Integration with the Build Cycle

In the github-orchestrator build flow, this check runs between Phase 0 (pre-context
intake) and Phase 1 (architect analysis):

```
Phase 0: Pre-context intake (read issue, clone repo, read CLAUDE.md)
    ↓
GUARDRAILS CHECK (this skill)
    ↓
  READY → Phase 1: Architect analysis (proceed normally)
  BLOCKED → Create guardrails issue → fix foundations first → resume
```

In subagent-driven-development, run this before dispatching the first task.
