## Problem Statement

Issue #82 requests a reusable function that returns the number of weeks between two dates, always non‑negative and allowing either order of inputs (`cliftonc/lastlight#82`). No such utility exists yet (search across `src/**/*.ts` only finds “weekly” in cron/job naming, not date math utilities; `src/workflows/loader.test.ts:191-201`, `src/cli.ts:36-40`). The function should be straightforward, self‑contained, and test‑covered using the existing Vitest test runner (`package.json:38-48`).

## Summary of What Needs to Change

- Add a small, focused date utility function that computes the whole‑week difference between two dates and returns a non‑negative number (integer).
- Expose this utility in an appropriate shared location so it can be reused by future features.
- Add unit tests under `src/**/*.test.ts` to pin behavior (ordering of dates, same date → 0, off‑by‑one boundaries, time components, etc.).
- Run `npm test` and `npm run build` to ensure tests pass and type checking is clean (`package.json:37-48`).

## Files to Modify

1. **New file**: `src/utils/date.ts` (or similar)
   - Implement `weeksBetween(dateA: Date | string, dateB: Date | string): number`.
   - Export the function for reuse.

2. **New file**: `src/utils/date.test.ts`
   - Vitest unit tests exercising core behavior and edge cases.

3. **(Optional, if project has a central barrel)**: `src/index.ts` or existing shared exports
   - If there is a pattern of re‑exporting helpers for external consumption, add `weeksBetween` there. (This file is referenced as the main entry in `CLAUDE.md:54-56` and `package.json:6`.)

If, during implementation, an existing utilities folder (e.g. `src/lib`, `src/shared`, `src/utils`) is discovered, place the function and tests in that established location instead of introducing a new pattern.

## Implementation Approach

1. **Locate / confirm utilities pattern**
   - Quick scan of `src/` to see if there is a `utils` or `lib` directory already in use.
   - If a generic utilities module exists, add `weeksBetween` there to match existing conventions; otherwise, introduce `src/utils/date.ts` as a focused date helper module.

2. **Decide function signature**
   - Use `weeksBetween(a: Date | string, b: Date | string): number`.
     - Accept `Date` for ergonomic use in code.
     - Accept ISO‑style strings (`YYYY-MM-DD` or full ISO timestamps) for flexibility and test convenience.
   - Internally normalize both inputs to `Date` instances:
     - If a parameter is a `Date`, use as‑is.
     - If a parameter is a string, construct `new Date(value)`.
     - Consider throwing a clear error if either is an invalid date (e.g. `Number.isNaN(date.getTime())`), vs silently returning `NaN`—the executor should align with project conventions once they inspect nearby utilities.

3. **Define week‑difference semantics**
   - Work in milliseconds:
     - `const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;`
   - Compute absolute millisecond difference:
     - `const diffMs = Math.abs(dateA.getTime() - dateB.getTime());`
   - Convert to weeks and return an integer:
     - Decide between:
       - **Floor**: `Math.floor(diffMs / MS_PER_WEEK)` → “full weeks between” (likely interpretation for “number of weeks”).
       - Or **round** / **ceil** if a different semantic is desired.
   - For this issue, plan around **full weeks** (floor) unless the maintainer indicates otherwise.
   - Ensure the function:
     - Returns `0` when the dates are the same (or less than 7 days apart).
     - Is symmetric: `weeksBetween(a, b) === weeksBetween(b, a)` (by using `Math.abs`).

4. **Handle date/time edge cases**
   - Time of day:
     - Using raw milliseconds makes the function sensitive to hours; `2024‑01‑01T00:00` to `2024‑01‑08T23:59` will be slightly less than 7 full 24‑hour days, so `Math.floor` would give 0 weeks.
     - To avoid surprising behavior, normalize to a consistent “day” boundary before diff:
       - E.g., set both to midnight UTC:
         - `const normalized = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));`
       - Then diff the normalized dates in ms and floor.
     - This yields date‑based week counts independent of time‑of‑day or timezones, which is generally more intuitive.
   - Time zones and DST:
     - Using UTC normalization avoids DST jumps and local timezone inconsistencies.
   - Document behavior in a short JSDoc comment above the function describing that it returns the number of whole calendar weeks between two dates (normalized to UTC midnight).

5. **Implement `weeksBetween`**
   - Implement in `src/utils/date.ts` (or equivalent):
     - Helper `toValidDate(input: Date | string): Date` to centralize parsing/validation.
     - Helper `normalizeToUtcMidnight(date: Date): Date` for day‑based semantics.
     - Main `weeksBetween` function that:
       - Validates inputs.
       - Normalizes both to UTC midnight.
       - Computes `Math.floor(Math.abs(aUtc.getTime() - bUtc.getTime()) / MS_PER_WEEK)`.
       - Returns the integer result.

6. **Add unit tests (`src/utils/date.test.ts`)**
   - Use Vitest (`package.json:37-38`, test files convention from Guardrails report).
   - Cover at least:
     - Same date:
       - `weeksBetween(new Date("2024-01-01"), new Date("2024-01-01")) === 0`.
     - Less than one week:
       - e.g. 3 days apart → 0.
     - Exactly one week:
       - `2024-01-01` to `2024-01-08` → 1.
     - Multiple weeks:
       - e.g. 4 full weeks apart → 4.
     - Reverse order:
       - `weeksBetween("2024-02-01", "2024-01-01")` equals `weeksBetween("2024-01-01", "2024-02-01")`.
     - String vs Date mixing:
       - One argument as `Date`, the other as ISO string.
     - Time components:
       - E.g. `2024‑01‑01T23:59Z` vs `2024‑01‑08T00:01Z` to verify normalization to UTC midnight yields intuitive “1 week” behavior.
     - Invalid input behavior:
       - If implementation chooses to throw for invalid dates, assert `toThrow`.
       - If it returns `NaN` or similar, assert that behavior explicitly.
   - Name tests descriptively so future readers understand semantics (`"returns full weeks between dates"`, `"ignores time of day via UTC normalization"`, etc.).

7. **Export the utility (if appropriate)**
   - Check `src/index.ts` for an export pattern (`CLAUDE.md:54-56` suggests it wires the app; it may or may not export helpers).
   - If the repo exposes helper APIs for reuse and this function is intended to be a general utility, re‑export `weeksBetween` from a central barrel. If it’s purely internal for now, keeping it internal is acceptable.

8. **Documentation touch (optional)**
   - If there is an internal developer‑facing doc for common utilities (none surfaced yet in the snippets), consider adding a one‑line mention of `weeksBetween` where appropriate, but this is non‑blocking.

## Risks and Edge Cases

- **Ambiguous semantics of “number of weeks”**:
  - Could be read as “full weeks”, “rounded weeks”, or “fractional weeks”.
  - Plan: implement “full calendar weeks between two dates” using UTC normalization + floor; make tests unambiguous so any future change is deliberate.
- **Time zone / DST behavior**:
  - Without normalization, DST transitions and time‑of‑day differences may cause unexpected off‑by‑one results.
  - Mitigation: normalize to UTC midnight before computing.
- **Invalid date inputs**:
  - Strings that parse to `Invalid Date` could silently propagate NaN.
  - Mitigation: explicitly validate and either throw a clear error or document/cover the behavior in tests.
- **Future reuse / breaking changes**:
  - If later code relies on specific semantics (e.g. fractional weeks), changing behavior will be breaking.
  - Mitigation: document clearly via JSDoc + tests.

## Test Strategy

- Unit tests:
  - `npm test` (Vitest, from `package.json:37-38`).
- Type checking / build:
  - `npm run build` (TypeScript via `tsc`, from `package.json:39`).

Ensure both commands pass after adding the new utility and tests.

## Estimated Complexity

- **Complexity: simple**
  - Small, self‑contained utility with straightforward arithmetic and a focused test suite.