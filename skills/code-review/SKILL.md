---
name: code-review
description: The shared rubric for reviewing a code change — precision-first, high-signal findings only (Critical/Important), plus what to check (correctness, security, edge cases, regression risk, test coverage). Use when reviewing a PR or a branch diff.
version: 2.0.0
tags: [review, code-quality]
---

# Code Review

The shared rubric for assessing a code change. Used both by a PR review and by
the build cycle's branch-diff reviewer — the *procedure* differs (where the diff
comes from, how the verdict is recorded), but the rubric below is the same.

Review the change **in full context** — read each changed file, not just the
hunk. For a large change (>300 lines or >5 files): trace data flow through
modified functions, check callers of anything whose signature or behaviour
changed for regression risk, and check that tests cover the actual risk areas,
not just the happy path.

## Precision first — post only what matters

A review is only useful if people trust it. A noisy reviewer gets muted; every
low-value comment you post spends the credibility of the ones that matter. So
the bar is **high-signal only**:

- **Post only Critical and Important findings.** Suggestions and Nits (below)
  are *not* worth a formal review comment on their own — drop them, or fold at
  most one genuinely valuable line into the summary. When in doubt, leave it out.
- **If you cannot name the concrete impact — what breaks, and for which input or
  caller — do not post it.** "This could be cleaner" is not a finding; "this
  crashes when `items` is empty because line 42 indexes `[0]`" is.
- **Confidence gate.** Before you finalise, re-read each finding against the
  actual code and try to *refute your own claim*. If you can't defend it against
  what the code actually does (not what you assumed), drop it. A missed marginal
  issue costs far less than a wrong one.

## Finding tiers

Categorise every finding into exactly one tier. **Only Critical and Important
are posted** (see Precision first):

- **Critical** — security issues, data loss, breaking changes, silent
  data-dropping (see Correctness below). Blocks merge.
- **Important** — missing tests, performance problems, type errors, **avoidable
  duplication**, **excessive complexity**, **compiler-silencing assertions**.
  Should fix.
- **Suggestions** — clarity, naming, minor DRY tidy-ups. *Not posted* — noise
  in a formal review.
- **Nits** — style, formatting. *Not posted* — this is the linter's job.

Every posted finding carries a **one-line concrete impact**: the consequence
(what breaks / for whom) and, where it helps, the fix. That local reasoning is
what makes a comment actionable rather than a vague worry.

## What to check

- **Correctness** — does it do what it claims? Logic errors, off-by-one, wrong
  conditions, mishandled async. **A silent default or a dropped output for an
  input the code doesn't support is a correctness bug, not graceful handling** —
  flag any unsupported case that is silently defaulted, skipped, or omitted
  instead of warned-and-skipped or warned-and-surfaced.
- **Edge cases** — empty/null inputs, boundaries, error paths, concurrency.
- **Security** — injection, auth/authorization, secret handling, untrusted input.
- **Complexity** — flag functions past ~15 cyclomatic complexity or that mix
  parse/validate/emit responsibilities; ask for helper extraction. This is an
  **Important** finding, not a nit.
- **Duplication** — flag avoidable duplicated logic (two or more clone groups of
  the same code/branching). DRY is **should-fix** here, not merely "nice to have."
- **Type safety** — flag `as any`, unchecked `as`-casts, or `@ts-ignore` used to
  silence the compiler or to bypass a validator the same code path defines.
- **Regression risk** — existing callers of changed functions; behaviour changes
  that ripple.
- **Test coverage** — do the tests exercise the real risk, or just the happy path?
- **Fit** — does it match the codebase's existing patterns and conventions?

## Calibration

- Don't nitpick generated files (lockfiles, compiled assets).
- Don't repeat what linters/CI already catch.
- Don't block over style preferences alone.
- Read the room: if a human reviewer already approved, lower the bar for blocking
  — prefer a comment over requesting changes on non-critical findings.
