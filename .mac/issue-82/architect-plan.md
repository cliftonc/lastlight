## Problem Statement

The issue requests a reusable function that calculates the number of whole weeks between two dates, returning a non-negative integer (no decimals) and handling the dates in any order (https://github.com/cliftonc/lastlight/issues/82). The repo already includes date-based cron and “weekly health” concepts (e.g., `weekly-health-report` in `src/workflows/loader.test.ts:191-201`), but there is no existing generic “week difference” utility. The new function should be a small, focused helper in the core codebase with appropriate tests, consistent with the project’s TypeScript style and test setup (`npm test`, `npm run build` from `package.json:7-17`).

## Summary of What Needs to Change

- Introduce a small, pure, TypeScript utility that computes the number of whole weeks between two `Date` inputs (order-agnostic, always non-negative, integer).
- Add comprehensive unit tests covering ordering, identical dates, partial weeks, leap years, daylight saving time transitions, and very large ranges.
- Export the utility from an appropriate shared module so it’s easy to reuse across the codebase.
- Ensure the project still builds and all tests pass (`npm run build`, `npm test`).

## Files to Modify

1. **New utility module (proposed)**
   - `src/engine/date-utils.ts` (or `src/state/date-utils.ts` / `src/utils/date.ts` depending on preferred location)
   - Purpose: Define and export the `getWeekDifference` (or `weekDifference`) function encapsulating the week-diff logic.
   - Reasons:
     - The engine already owns workflow and scheduling logic (`src/engine/router.ts:70-83`, `src/cron` etc. in `CLAUDE.md:137-142`), so `engine` is a reasonable home for reusable scheduling/date helpers.
     - Keeping this separate avoids polluting unrelated modules.

2. **Utility barrel export**
   - `src/index.ts` (or another central export if there is a utilities barrel; you’ll need to open this to confirm where shared helpers are exported from, as CLAUDE.md notes this as the main entry point at `CLAUDE.md:55-56`).
   - Purpose: Re-export the new function so it’s readily available for future use.

3. **New test file**
   - `src/engine/date-utils.test.ts` (or parallel to wherever you place the utility, matching existing test layout).
   - Purpose: Unit tests for the week difference function using Vitest (as configured in `vitest.config.ts` and described in the guardrails report).

4. **(Optional, if a utils directory already exists)**
   - If you discover an existing general-purpose utilities module (e.g., `src/engine/utils.ts` or `src/shared/date.ts`), prefer adding the function and tests alongside that instead of a brand new module.

## Implementation Approach

1. **Locate the appropriate module for shared helpers**
   - Inspect `src/` layout (guided by `CLAUDE.md:51-75`) to see if there’s already:
     - A generic utilities module (e.g., `src/engine/utils.ts`, `src/state/utils.ts`), or
     - Existing date/time helpers (e.g., anything in `src/cron`, `src/workflows`, or `src/state`).
   - Choose the most natural place:
     - If a date-focused util already exists → add to that file.
     - If not, create `src/engine/date-utils.ts` as a new, small util file.

2. **Define the function signature**
   - Implement a pure function with a clear name and types, for example:
     - `export function getWeekDifference(a: Date | string | number, b: Date | string | number): number`
   - Consider whether to accept only `Date` objects or also timestamps/ISO strings:
     - The issue description only mentions “two dates” informally, not ergonomics.
     - To keep scope tight and predictable, start with `Date` inputs:
       - `export function getWeekDifference(a: Date, b: Date): number`
     - If you want a bit more convenience, you can add a small internal normalizer that accepts `Date|string|number` and always converts to `Date`, but this is optional and should be clearly documented.

3. **Implement order-agnostic, non-negative logic**
   - Convert both inputs to millisecond timestamps:
     - `const t1 = a.getTime(); const t2 = b.getTime();`
   - Compute the absolute difference:
     - `const diffMs = Math.abs(t1 - t2);`
   - Define the number of milliseconds per week:
     - `const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;`
   - Convert to weeks, ensuring:
     - Non-negative integer.
     - No decimals: use `Math.floor(diffMs / MS_PER_WEEK)` to represent "full weeks between".
   - Return this integer as the result.
   - This approach inherently handles input order and ensures the result is always ≥ 0.

4. **Document behavior and assumptions**
   - In the JSDoc/TSDoc above the function, clarify:
     - It returns the number of **full weeks** between two instants in time.
     - It does not round up partial weeks; they are truncated.
     - It uses absolute difference, so the order of arguments doesn’t matter.
     - It operates on UTC timestamps (`Date.getTime()`), which is not affected by local timezone differences other than how the `Date` was instantiated.

5. **Handle edge cases explicitly**
   - Identical dates → diff is 0 ms → 0 weeks.
   - Dates less than one full week apart → still 0.
   - Very large ranges (e.g., decades) → should remain correct as long as JS `Date` supports the range (it does for typical repo timelines).
   - Leap years and variable month lengths are implicitly handled since the function works at the millisecond level, not by counting calendar weeks.
   - Daylight saving time:
     - Because we use timestamps, which are absolute, DST shifts don’t break correctness of total elapsed time.
     - Add tests that specifically straddle a DST boundary to verify expected integer results.

6. **Add comprehensive unit tests**
   - Create a dedicated test file (e.g., `src/engine/date-utils.test.ts`), following existing test structure (Vitest).
   - Tests to include:
     1. **Same date**
        - `getWeekDifference(d, d)` → `0`.
     2. **Less than one week apart**
        - e.g., `2024-01-01` vs `2024-01-03` → `0`.
     3. **Exactly one week apart**
        - `2024-01-01` vs `2024-01-08` → `1`.
     4. **Multiple weeks**
        - e.g., 21 days apart → `3`.
     5. **Order agnostic**
        - Swap arguments and verify the result is identical.
     6. **Large span**
        - 365 days apart → `Math.floor(365 / 7)` = `52`.
     7. **Leap year boundary**
        - e.g., `2020-02-01` vs `2020-03-01`; assert floor(29 days / 7) = `4`.
     8. **DST transition**
        - Use dates in a timezone that has DST (e.g., US) and create `Date` instances explicitly with UTC components to avoid ambiguity.
        - Verify that an interval that “looks like” exactly 7 days in UTC yields `1`, and that an interval slightly shorter/longer behaves as expected.
   - Use descriptive test names so future contributors understand the semantics.

7. **Wire up exports (if needed)**
   - If there is a central public API file (likely `src/index.ts`, noted in `CLAUDE.md:55-56` as “Main entry”), add a named export for the new function:
     - `export { getWeekDifference } from "./engine/date-utils";`
   - If utilities are not intended as part of the public API and only used internally, you can skip this and rely on internal imports only; clarify with a short comment in the module if necessary.

8. **Optionally add a brief note for future use**
   - If you anticipate this helper being useful for scheduling logic (e.g., repo health cadence, weekly reports), add a short inline comment in cron-related modules you touch later (not in this issue) referencing this utility.
   - For now, keep this issue strictly scoped to introducing the function + tests and not refactoring existing cron code.

## Risks and Edge Cases

- **Definition of “weeks between”**: The implementation will use **full weeks based on elapsed time** (floor of absolute difference in milliseconds divided by `MS_PER_WEEK`). If someone expects inclusive calendar-week counting (e.g., “Monday to next Monday is 1, Monday to Sunday is 1”), expectations might differ. Mitigation: clear tests and docstring.
- **Time zone confusion**: JavaScript `Date` implicitly uses local timezone for parsing date-only strings; tests should construct `Date` via `new Date(Date.UTC(...))` or explicit full ISO strings with `Z` to ensure consistent behavior.
- **API surface creep**: Exposing the function in the root index may signal a stable API; if that’s not desired, keep it internal to `src/engine/` and use relative imports only until there’s a stable utilities layer.

## Test Strategy

- **Unit tests**
  - Run Vitest:
    - `npm test`
- **Type checking / build**
  - Ensure TypeScript compilation passes:
    - `npm run build`

If the repo has any additional test scripts or CI workflows referencing date utilities, the executor should also confirm those still pass, but the above two commands are the core verification steps.

## Estimated Complexity

- **Estimated complexity: simple**
  - Single small pure function with straightforward arithmetic.
  - A modest but clear set of unit tests.
  - Minimal integration with the rest of the codebase.