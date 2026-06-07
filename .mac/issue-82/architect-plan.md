### Problem Statement

Issue #82 requests a reusable function that calculates the number of weeks between two dates, always returning a non-negative integer number of weeks (no decimals) and handling input dates in any order. The codebase already has general utilities but no date-difference helper targeted at “week difference” specifically (no relevant hits under `src/**/*.ts` for “week” beyond comments and workflow/job names; see `src/cli.ts:9-13`, `src/workflows/loader.test.ts:191-201, 224-226, 349-361`). This new helper should fit into the existing TypeScript utility/module structure and be tested via Vitest.

### Summary of What Needs to Change

- Introduce a small date utility function, e.g. `getWeekDifference` or `weeksBetween`, that:
  - Accepts two `Date` (or date-like) inputs.
  - Computes the absolute difference between them in weeks.
  - Returns a whole number of weeks (`number`), with 0 as the minimum.
- Add unit tests to verify correctness and edge cases (order of dates, same day, <1 week, multiple weeks, DST / timezone behavior).
- Optionally, export the helper from an index/module barrel if there is a public utility surface that should expose it.

### Files to Modify

1. **New utility file (likely under `src/`)**

   The exact location will depend on existing utility patterns. The executor should inspect these to choose the best home:

   - `src/` root and utility-like modules:
     - `src/config.ts`, `src/index.ts`, etc. provide core harness plumbing (see `CLAUDE.md:51-72` for layout), but utilities might live under:
       - `src/state/` (if there are generic helpers already),
       - `src/engine/` (if there are date/time helpers used for cron/health),
       - or a dedicated util module like `src/utils/date.ts` (to be created if no better fit exists).

   **Planned change:**
   - Create a new file such as `src/utils/date.ts` (or another appropriate existing util module) that exports the `weeksBetween` function.

2. **Test file for the helper**

   - There are multiple test files under `src/**` (e.g. `src/admin/auth.test.ts`, `src/engine/router.test.ts`, `src/state/db.test.ts` noted in the guardrails report).
   - Mirror that pattern by adding a test file alongside the utility, e.g.:
     - `src/utils/date.test.ts`
     - or place it next to whichever module you put the implementation in.

   **Planned change:**
   - Add Vitest tests that import the helper and cover:
     - `weeksBetween(dateA, dateB)` where `dateA === dateB` → `0`.
     - `weeksBetween` with `dateA` before `dateB` and vice versa → same positive result.
     - Differences less than 7 days should round down to `0` weeks (if using integer division).
     - Differences equal to exactly 7, 14, 21 days, etc. → `1`, `2`, `3`, … weeks.
     - A case around DST to confirm that using UTC math avoids off-by-one-day artifacts.

3. **Optional: export surface (barrel)**

   - If there is a central exports file that aggregates utilities (for instance an `src/index.ts` that re-exports helpers for external use; see `CLAUDE.md:54-60` and `README.md:132-148` showing `src/index.ts` as the main entry point), consider whether this helper should be publicly exposed.
   - If yes, modify:
     - `src/index.ts` (or another appropriate barrel) to re-export `weeksBetween`.

   **Planned change:**
   - Add a named export, e.g. `export { weeksBetween } from "./utils/date";` if such a public surface is desired.

### Implementation Approach

1. **Determine the module location**

   - Inspect `src/` for any existing utility modules (e.g. `src/utils/*.ts`, `src/shared/*.ts`, or date/time-related helpers). Place the function where general-purpose, non-domain-specific helpers live.
   - If there is no clear date utility module, create `src/utils/date.ts` to hold the new function (consistent with other utility naming conventions, if any).

2. **Define the function signature**

   - Prefer a simple, strongly typed API:
     ```ts
     export function weeksBetween(a: Date, b: Date): number { ... }
     ```
   - Optionally, you could later overload or accept `string | number | Date` if that’s consistent with other utilities, but for now keep it minimal per the issue request.

3. **Implement week difference logic**

   - Normalize to UTC and use integer division on milliseconds to avoid timezone/DST surprises:
     - Convert each `Date` to UTC epoch time in milliseconds:
       ```ts
       const timeA = a.getTime();
       const timeB = b.getTime();
       ```
     - Compute absolute difference:
       ```ts
       const diffMs = Math.abs(timeA - timeB);
       ```
     - Compute full weeks as an integer:
       ```ts
       const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
       const weeks = Math.floor(diffMs / MS_PER_WEEK);
       return weeks;
       ```
   - This satisfies:
     - Non-negative (`Math.abs`),
     - Integer weeks (`Math.floor`),
     - No decimals, maximum granularity 1 week,
     - Same date → `0`.

4. **Document the behavior briefly in code**

   - Add a short JSDoc comment at the function definition explaining:
     - That it returns the number of whole weeks between two dates.
     - That it’s order-independent and uses UTC epoch math.
     - That partial weeks are truncated (not rounded).

5. **Add tests**

   - Create a test file (e.g. `src/utils/date.test.ts`).
   - Use Vitest with the existing repo test style (inspect other `.test.ts` files to match imports and describe/it patterns).
   - Test cases:
     - `weeksBetween(sameDate, sameDate)` → `0`.
     - `weeksBetween(2024-01-01, 2024-01-08)` and reversed order → `1` week both ways.
     - `weeksBetween(2024-01-01, 2024-01-07)` → `0` weeks (6 days difference).
     - `weeksBetween(2024-01-01, 2024-01-15)` → `2` weeks.
     - A DST-adjacent case, e.g. spanning across a known DST change date in your target timezone; verify that using pure epoch math still gives the correct number of 7-day blocks in UTC (e.g. two dates 21 days apart still yield 3 weeks).
   - Consider adding a quick sanity check around very large differences (e.g. multiple years apart) to ensure performance and correctness.

6. **Optional: public export**

   - If the project exposes general-purpose helpers for use by other packages or scripts, add the export to `src/index.ts` or an appropriate barrel. This depends on how exported APIs are currently designed:
     - If `src/index.ts` currently exports only runtime server/harness functionality, and not pure utilities, you might instead leave this helper internal. Let the maintainer decide based on usage intent.

7. **Run tests and type check**

   - Ensure the new file passes TypeScript compilation:
     - `npm run build`
   - Run the test suite:
     - `npm test`

### Risks and Edge Cases

- **Timezone / DST effects:** Using raw `Date` objects combined with local timezone operations can produce off-by-one-day errors around DST transitions. Basing the calculation on `getTime()` in milliseconds (UTC-based) and dividing by a constant `MS_PER_WEEK` mitigates this.
- **Partial weeks:** The requirement is “always returns a positive number or 0 – no decimals.” The precise handling of partial weeks is not fully specified. This plan uses truncation via `Math.floor`, which is intuitive (e.g. 13 days → 1 week). If the maintainer prefers rounding to the nearest week, behavior will need adjustment.
- **Input types:** If future callers pass strings or timestamps, the function’s narrow `Date` signature will require explicit conversions. That is generally safer than overloading prematurely, but worth noting.
- **Public API stability:** If this helper is exported from the main entrypoint, its signature becomes part of the public surface; future changes will be a breaking change.

### Test Strategy

- **Unit tests for the helper (Vitest):**
  - Command: `npm test`
  - Verify that the new test file is picked up by the existing Vitest configuration (default behavior with `*.test.ts` under `src/`).
- **Type-check / build:**
  - Command: `npm run build`
  - Ensures the new module and its exports are consistent with the rest of the codebase and `tsconfig.json`.

### Estimated Complexity

- **Complexity: simple**

The change is localized (one small utility function plus tests) with no need to modify complex engine or workflow logic.