# Architect Plan for Issue #123 — New Date Helper Function

## Problem Statement

- The CLI currently exposes a single human-readable time helper, `age(input)` in `src/cli-format.ts:30-42`, which formats the difference between **now** and a single timestamp as strings like `"3m ago"`.
- There is no general-purpose helper to compute a human-readable duration **between two arbitrary dates**, as requested in issue #123 ("calculate the time between two dates in a human readable output").
- Other parts of the codebase perform date arithmetic directly (e.g. `Date` and epoch math in `src/admin/sessions.ts` and stats routes), but they lack a shared, tested utility for rendering a human-friendly duration string.
- Adding a reusable, well-tested helper will avoid reimplementing date-diff logic in multiple places and give a single, documented contract for "time between two dates" formatting.

## Summary of What Needs to Change

- Introduce a new, dependency-free date utility module that provides a function to compute a compact human-readable duration string **between two dates**.
- Define a clear input contract (supported date-like types and units) and output contract (range of formats, rounding rules, maximum unit granularity).
- Ensure invalid or unsupported inputs are **surfaced explicitly** (e.g. `"invalid date range"`) rather than failing silently.
- Add unit tests to lock in behavior at key thresholds (seconds, minutes, hours, days) and across input types (ISO strings, `Date`, unix-seconds numbers).

## Files to Modify (Exhaustive)

1. `src/date-helpers.ts` **(new file)**
   - **Purpose:** Centralized, reusable date/duration helpers that are free of CLI-only concerns like `chalk`.
   - **Add:**
     - `export type DateLike = string | number | Date;`
     - Internal helper `function toMillis(input: DateLike | null | undefined): number | null` that:
       - Treats `null`, `undefined`, and `""` as invalid (`null` return).
       - For `Date` instances, returns `input.getTime()`.
       - For `number`, treats the value as **unix seconds** (matching `age()`'s contract in `src/cli-format.ts:30-42`) and multiplies by 1000.
       - For `string`, uses `Date.parse(input)`; if `Number.isNaN`, returns `null`.
     - `export function humanDurationBetween(start: DateLike | null | undefined, end: DateLike | null | undefined): string` that:
       - Uses `toMillis` on both inputs.
       - If **either** side is invalid (`null` from `toMillis`) or both are `null`:
         - Returns the literal string `"invalid date range"`.
         - This is the **warn-and-surface** behavior for unsupported inputs; callers see an explicit failure marker instead of an empty or misleading value.
       - Computes `const diffMs = Math.abs(endMs - startMs)` so argument order does not matter.
       - Derives `const sec = Math.round(diffMs / 1000)`, then:
         - If `sec < 60`: returns ```${sec}s```.
         - Else, `const min = Math.round(sec / 60)`:
           - If `min < 60`: returns ```${min}m```.
           - Else, `const hr = Math.round(min / 60)`:
             - If `hr < 48`: returns ```${hr}h```.
             - Else, returns ```${Math.round(hr / 24)}d```.
       - Handles a zero-diff case (identical timestamps) by returning `"0s"`.
       - Has a short JSDoc comment clarifying:
         - Supported input types.
         - That numbers are **unix seconds**, not milliseconds.
         - That output is a compact, unit-only string (`"3m"`, `"2h"`, `"5d"`) with no "ago" suffix.
   - **Notes:**
     - Keep this module self-contained with no imports other than built-ins, so it can be reused by both CLI and server code in future changes.

2. `src/date-helpers.test.ts` **(new file)**
   - **Purpose:** Unit tests for `humanDurationBetween` to document and protect its behavior.
   - **Add tests for:**
     - **Basic ranges** (using ISO strings):
       - `start = "2024-01-01T00:00:00Z"`, `end = "2024-01-01T00:00:30Z"` → `"30s"`.
       - `start = "2024-01-01T00:00:00Z"`, `end = "2024-01-01T00:01:00Z"` → `"1m"`.
       - `start = "2024-01-01T00:00:00Z"`, `end = "2024-01-01T01:00:00Z"` → `"1h"`.
       - `start = "2024-01-01T00:00:00Z"`, `end = "2024-01-03T00:00:00Z"` → `"2d"`.
       - Identical timestamps → `"0s"`.
     - **Argument order independence:**
       - Swapping `start` and `end` for a given pair yields the same string.
     - **Input type coverage:**
       - `Date` objects as both inputs.
       - `number` inputs treated as unix seconds (e.g. `start = 1_700_000_000`, `end = 1_700_000_060` → `"60s"` / `"1m"`).
       - Mixed types (e.g. `Date` and ISO string) to ensure `toMillis` handles them symmetrically.
     - **Invalid/unsupported input handling (warn-and-surface):**
       - `humanDurationBetween(null, new Date())` → `"invalid date range"`.
       - `humanDurationBetween("", "2024-01-01T00:00:00Z")` → `"invalid date range"`.
       - `humanDurationBetween("not-a-date", "2024-01-01T00:00:00Z")` → `"invalid date range"`.
       - `humanDurationBetween("not-a-date", "also-bad")` → `"invalid date range"`.
   - **Test style:**
     - Follow the existing Vitest patterns used elsewhere in `src/*.test.ts` (e.g. `describe`/`it`, `expect(...).toBe(...)`).

3. `.lastlight/issue-123/status.md`
   - **Current content:**
     - `current_phase: guardrails`
     - `guardrails_status: READY`
   - **Change:**
     - Update `current_phase` to `architect` while preserving `guardrails_status`:
       - `current_phase: architect`
       - `guardrails_status: READY`

> Note: Existing files like `src/cli-format.ts` already contain an `age()` helper (`src/cli-format.ts:30-42`), but this plan deliberately avoids refactoring it in this issue. Future work can optionally reimplement `age()` in terms of `humanDurationBetween` if reuse is desired.

## Commands (from Guardrails Report)

The executor should use these as the primary safety rails:

- Run tests:
  - `npm test`
- Type-check / build:
  - `npm run build`

## Implementation Approach (Step-by-Step)

1. **Create `src/date-helpers.ts`:**
   - Define `DateLike` and `toMillis` as described above.
   - Implement `humanDurationBetween(start, end)`:
     - Parse both inputs via `toMillis`.
     - If either is `null`, return `"invalid date range"`.
     - Compute `diffMs = Math.abs(endMs - startMs)` and derive seconds/minutes/hours/days using `Math.round` at each step, mirroring the threshold behavior of `age()`.
     - Return a compact string without any suffix: `"Xs"`, `"Xm"`, `"Xh"`, or `"Xd"`.
   - Add a short JSDoc block explaining the contract.

2. **Add tests in `src/date-helpers.test.ts`:**
   - Import `humanDurationBetween` from `./date-helpers.js`.
   - Write grouped tests for:
     - Normal ranges (seconds, minutes, hours, days).
     - Zero-duration case.
     - Swapped start/end order.
     - Different input types (ISO strings, `Date`, unix-seconds numbers, mixed types).
     - Invalid inputs and the `"invalid date range"` fallback.

3. **Run guardrail commands locally in the sandbox:**
   - `npm test` — verify the new tests pass and do not break existing suites.
   - `npm run build` — ensure the new module type-checks cleanly and does not introduce compilation errors.

4. **Finalize status metadata:**
   - Update `.lastlight/issue-123/status.md` to `current_phase: architect` as described above.

## Risks and Edge Cases

- **Ambiguity of numeric inputs:**
  - Risk: Callers might expect numeric inputs to be **milliseconds** instead of **unix seconds**.
  - Mitigation: The JSDoc on `humanDurationBetween` will explicitly document that numbers are unix seconds, mirroring `age()`'s contract. If a caller passes ms by mistake, the function will still return a string, but the magnitude will be wrong; tests will clarify intended use.

- **Invalid or poorly formatted date strings:**
  - Behavior: Any input that `Date.parse` cannot parse, or `null`/`undefined`/`""`, yields `"invalid date range"`.
  - This is an explicit **warn-and-surface** behavior: callers see a non-empty, clearly invalid marker instead of an empty or misleading value.

- **Time zone concerns:**
  - `Date.parse` interprets ISO-8601 strings correctly and other formats according to JS semantics. Since we only care about the **difference** in epoch milliseconds, consistent parsing is sufficient.
  - Edge case: Mixed local-time and UTC strings can produce surprising diffs, but that is inherent to JS parsing; the helper will faithfully reflect the underlying `Date` behavior. This should be documented briefly in the JSDoc comment.

- **Very large ranges:**
  - For differences larger than several weeks/years, the helper still returns values in days (e.g. `"365d"`).
  - This is acceptable for the small, compact output requested; if richer formatting (months/years) is needed later, the function can be extended in a backward-compatible way by adding options.

- **Negative ranges / reversed arguments:**
  - Using `Math.abs(endMs - startMs)` ensures that argument order cannot produce negative or confusing output.

## Test Strategy

- **Unit tests:**
  - Cover all primary branches of `humanDurationBetween` in `src/date-helpers.test.ts`:
    - Each unit band (seconds, minutes, hours, days).
    - Zero-diff behavior.
    - Swapped arguments.
    - Input types: ISO strings, `Date`, unix-seconds numbers, and mixed.
    - Invalid/unsupported inputs returning `"invalid date range"`.

- **Regression guard:**
  - Ensure `npm test` and `npm run build` both pass after adding the new module and tests, confirming no impact on unrelated parts of the system.

## Estimated Complexity

- **Complexity:** simple
- Rationale: The change is localized to introducing one small, pure helper function and a focused test file, with no behavior changes to existing modules or external APIs.