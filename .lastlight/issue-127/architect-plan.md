# Architect plan for issue #127 – Helper function for human-readable date differences

## Problem Statement

The CLI currently exposes an `age()` helper (src/cli-format.ts:30-42) that formats the difference between a single timestamp and **now** using terse units like `3m ago`, but there is no reusable function for computing the difference *between two arbitrary dates* in human-readable form. This limits reuse and forces any future feature that needs a human description of a time span (e.g. dashboards, logs, notifications) to either duplicate the `age()` logic or roll its own. Issue #127 requests a generic helper that expresses the difference between two dates in natural language, while remaining lightweight and suitable for CLI and server-side use. Implementing this as a shared utility and adding tests will also lock in behavior and prevent regressions in the existing `age()` formatting.

## Summary of what needs to change

- Introduce a small, dependency-free helper that takes two date-like inputs and returns an English human-readable description of the elapsed time between them.
- Keep the new helper generic (no dependency on `chalk` or CLI concerns) so it can be used in both the CLI and any future internal callers.
- Refactor the existing `age()` function in src/cli-format.ts:30-42 to build on top of the new helper, preserving its current abbreviated output (`3s/3m/3h/3d ago`).
- Add unit tests to validate both the new date-difference helper and the existing `age()` behavior (to avoid unintentional breaking changes).

## Files to modify (exhaustive)

### 1. src/human-time.ts (NEW)

**Purpose:** Shared, pure helper for human-readable differences between two dates, with no CLI- or color-specific dependencies.

Planned contents:

- Define a local `type DateLike = Date | string | number;` and a small options type:
  - `export interface HumanDateDiffOptions { style?: "short" | "long"; }` (default `"long"`).
- Implement a small normalization helper:
  - `function toMillis(input: DateLike): number | null` — converts a `Date`, ISO string, or unix-epoch seconds/millis number to a millisecond timestamp.
    - If parsing fails, returns `null` so the caller can surface a clear warning string.
- Implement the main helper:
  - `export function humanDateDiff(from: DateLike, to: DateLike, options: HumanDateDiffOptions = {}): string`.
  - Logic:
    - Normalize both inputs via `toMillis`; if either is `null`, return a sentinel string like `"[invalid date]"` **(warn-and-surface, not silent)**.
    - Compute `const diffMs = Math.abs(toMs - fromMs);` so the function always expresses the absolute elapsed time between the two dates (direction-agnostic).
    - Choose the dominant unit via simple thresholds (all inclusive of boundary values):
      - `< 60 seconds` → seconds (rounded to nearest integer).
      - `< 60 minutes` → minutes.
      - `< 48 hours` → hours.
      - `< 60 days` → days.
      - `< 24 months` (approximate as `30 * 24 * 60 * 60 * 1000` ms per month) → months.
      - `>= 24 months` → years (approximate as `365 * 24 * 60 * 60 * 1000` ms per year).
    - For `style: "long"` (default), return strings like `"45 seconds"`, `"3 minutes"`, `"2 hours"`, `"5 days"`, `"4 months"`, `"2 years"` with correct pluralization.
    - For `style: "short"`, return abbreviated units like `"45s"`, `"3m"`, `"2h"`, `"5d"`, `"4mo"`, `"2y"`.
    - For a zero or sub-second difference, return `"0 seconds"` (`"0s"` in short form) so the caller never gets an empty string; there is always a surfaced value.
- (Optionally) Export a very small convenience wrapper for now-based differences if desired in future (`humanAge(since: DateLike, options?: HumanDateDiffOptions)`), but the core of the work is the two-argument `humanDateDiff`.

### 2. src/cli-format.ts

**Anchor:** existing helper definitions at src/cli-format.ts:30-42 and imports at the top of the file.

Planned changes:

- Add an import for the new helper near the existing imports (top of file):
  - `import { humanDateDiff } from "./human-time.js";`
- Refactor `age()` (src/cli-format.ts:30-42) to delegate unit selection to `humanDateDiff` while preserving current external behavior:
  - Keep the `input` type and early returns unchanged (`null` / `undefined` / empty string → `""`; non-parsable input → `String(input)`), because CLI callers already rely on this behavior.
  - After normalizing `input` to a millisecond timestamp as today (`ms`), compute the diff to `Date.now()` and call `humanDateDiff` in short mode:
    - e.g. `const now = Date.now(); const span = humanDateDiff(ms, now, { style: "short" });`
  - Append the `" ago"` suffix exactly as today, so outputs remain `"3s ago"`, `"2m ago"`, `"1h ago"`, `"2d ago"`.
  - Ensure the behavior for the exact thresholds (e.g. 59 seconds vs 60 seconds) matches current behavior by aligning the `humanDateDiff` thresholds to the existing `age()` thresholds.
- Optionally add a non-exported internal helper (if needed) to normalize CLI `input` values to milliseconds, but keep all external signatures (`age`, `table`, `colorStatus`, `checkmark`, `followSSE`) unchanged.

### 3. src/human-time.test.ts (NEW)

**Purpose:** Unit tests for the new helper to lock behavior and document edge cases.

Planned contents:

- Import the helper: `import { humanDateDiff } from "./human-time.js";`.
- Test cases:
  - **Basic units (long style):**
    - `1 second`, `30 seconds`, `59 seconds` → `"1 second"`, `"30 seconds"`, `"59 seconds"`.
    - `61 seconds`, `5 minutes`, `59 minutes` → `"1 minute"`, `"5 minutes"`, `"59 minutes"`.
    - An hour-range span (`2 hours`, `36 hours`) → `"2 hours"`, `"36 hours"`.
    - Multi-day spans (`3 days`, `45 days`) → `"3 days"`, `"45 days"`.
    - Multi-month spans (`90 days` ≈ `3 months`) → `"3 months"`.
    - Multi-year spans (`3 years` difference) → `"3 years"`.
  - **Short style:**
    - Same spans with `{ style: "short" }` produce `"45s"`, `"3m"`, `"2h"`, `"5d"`, `"4mo"`, `"2y"`.
  - **Direction-agnostic behavior:**
    - `humanDateDiff(later, earlier)` and `humanDateDiff(earlier, later)` both return the same string (absolute difference).
  - **Zero / near-zero difference:**
    - Identical `from` and `to` dates ⇒ `"0 seconds"` (long) and `"0s"` (short).
  - **Invalid inputs (warn-and-surface):**
    - If either argument cannot be parsed (`"not-a-date"`, `NaN`), the function returns the sentinel string `"[invalid date]"`.

### 4. src/cli-format.test.ts (NEW)

**Purpose:** Tests specifically for `age()` to ensure the refactor to use `humanDateDiff` does not change observable behavior.

Planned contents:

- Import the CLI helper: `import { age } from "./cli-format.js";`.
- Test cases:
  - **Null/undefined/empty handling:**
    - `age(null)`, `age(undefined)`, `age("")` each return `""`.
  - **ISO and numeric input parsing:**
    - For a timestamp exactly 30 seconds in the past, `age()` returns `"30s ago"`.
    - For ~90 seconds in the past, `age()` returns `"2m ago"` (rounded minutes).
    - For ~3 hours in the past, `age()` returns `"3h ago"`.
    - For ~3 days in the past, `age()` returns `"3d ago"`.
  - **Non-parsable input (warn-and-surface):**
    - `age("not-a-date")` returns `"not-a-date"` (the current behavior), confirming that invalid input remains surfaced rather than silently dropped or converted.

## Commands (from guardrails-report.md)

The executor should use these commands to verify changes:

- Tests: `npm test`
- Typecheck (full project, may OOM locally but runs in CI): `npx tsc --noEmit`
- Dashboard typecheck (runs in CI): `npx tsc -b dashboard`

If local typechecking crashes due to sandbox memory limits, rely on CI for the full `tsc` runs and optionally run narrower `tsc` invocations against just the changed files during development.

## Implementation approach (step-by-step)

1. **Add the shared helper module**
   - Create `src/human-time.ts` with the `DateLike` type, `HumanDateDiffOptions` interface, `toMillis` normalizer, and `humanDateDiff` implementation as described above.
   - Ensure the implementation is pure and does not depend on `chalk` or any CLI I/O.
2. **Wire the CLI helper to the shared logic**
   - Update `src/cli-format.ts` to import `humanDateDiff` at the top of the file.
   - Refactor `age()` to:
     - Preserve the existing early returns (`""` for null/undefined/empty, `String(input)` for unparseable values).
     - For valid inputs, compute the millisecond value of `input`, then call `humanDateDiff(inputMs, Date.now(), { style: "short" })` to get the abbreviated span, and append `" ago"`.
     - Align thresholds so a span that previously produced `"59s ago"`, `"1m ago"`, `"1h ago"`, etc., still produces the same string.
3. **Add targeted unit tests**
   - Create `src/human-time.test.ts` with focused tests for `humanDateDiff` covering the unit thresholds, style switching, zero-diff handling, direction-agnostic behavior, and invalid inputs.
   - Create `src/cli-format.test.ts` with tests for `age()` that document and lock in current behavior (including invalid-input handling).
4. **Run the guardrail commands**
   - Run `npm test` and ensure all existing and new tests pass.
   - Attempt `npx tsc --noEmit` and `npx tsc -b dashboard`; if they fail with OOM (exit code 137) in the sandbox, note that CI is expected to run them successfully and that the changes are type-safe in the edited files.
5. **Documentation / discoverability (optional)**
   - If desired, add a short comment above `humanDateDiff` in `src/human-time.ts` explaining its intended use (“Compute a human-readable description of the elapsed time between two dates, e.g. `3 minutes` or `2 days`. Used by the CLI `age()` helper and available for other callers.”).

## Risks and edge cases

- **Invalid date inputs:**
  - Risk: Callers may pass strings or numbers that cannot be parsed into valid dates.
  - Plan: `humanDateDiff` will treat any unparseable input as an error and return the explicit sentinel string `"[invalid date]"` (**warn-and-surface**). It will not throw, and it will not return an empty string that could be misinterpreted as “no data”.
  - For `age()`, existing behavior (`String(input)` on parse failure) will be preserved and tested; this is effectively **warn-and-surface** as well, since the raw invalid value is printed back to the user.
- **Zero or sub-second differences:**
  - Risk: `from` and `to` may be equal or differ by less than one second, leading to confusing or empty output.
  - Plan: Treat any difference under one second as `0 seconds` (`"0s"` in short style), so the user always sees an explicit “0” span rather than a blank field (**warn-and-surface** actual zero-length duration).
- **Very large spans (years/decades):**
  - Risk: Extremely large differences could overflow naive arithmetic or produce awkward phrasing.
  - Plan: Use `number`-safe constants and simple approximations for months/years; for any sufficiently large span, we still return a finite, readable value like `"25 years"`. There is no silent truncation or omission.
- **Approximate month/year calculations:**
  - Risk: Approximating months as 30 days and years as 365 days ignores leap years and varying month lengths.
  - Plan: Accept this as a deliberate approximation suitable for human-friendly CLI output and document it in code comments. The function still provides a clear, surfaced estimate (e.g. `"11 months"` vs `"1 year"`), and there is no hidden dropping of data.
- **Direction of time (past vs future):**
  - Risk: The helper might need to distinguish “in 3 minutes” vs “3 minutes ago”.
  - Plan: `humanDateDiff` will remain direction-agnostic (absolute span). Directional phrasing is the responsibility of callers like `age()`, which already appends `" ago"`. If a future caller needs “in X”, it can compare `from`/`to` itself and wrap the string. This keeps the helper simple and predictable.

## Test strategy

- **Unit tests for the new helper:**
  - `src/human-time.test.ts` will cover unit thresholds, style switching, zero-diff behavior, invalid input handling, and direction-agnostic behavior.
- **Regression tests for `age()`:**
  - `src/cli-format.test.ts` will assert the current outputs for representative time spans and invalid inputs, ensuring the refactor to use `humanDateDiff` does not change the CLI’s external behavior.
- **Whole-project test suite:**
  - Run `npm test` to ensure the entire Vitest suite (including the new tests) passes.
- **Typechecking:**
  - Attempt `npx tsc --noEmit` and `npx tsc -b dashboard` locally (even if they may OOM in this sandbox) to catch any obvious type issues near the changed files; rely on CI for full, reliable project-wide typechecking.

## Estimated complexity

- **Complexity:** simple
- Rationale: The change is localized to a small, pure utility and a light refactor of an existing helper, plus straightforward unit tests, with no impact on external APIs beyond adding a new exported helper.