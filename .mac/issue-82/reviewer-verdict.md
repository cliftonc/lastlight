# Reviewer verdict (cycle 1)

Verdict: REQUEST_CHANGES

The implementation is solid and matches most of the plan, but one important item from the architect’s spec is missing.

## Critical

_None._

## Important (blocking)

1. **Utility is not re-exported from a central module**

   The plan explicitly called for making this helper easy to reuse:

   > “Export the utility from an appropriate shared module so it’s easy to reuse across the codebase.”  
   > “If there is a central public API file (likely `src/index.ts` …), add a named export for the new function…”

   The diff does not show any change to `src/index.ts` (or another central barrel). As-is, `getWeekDifference` exists only in `src/engine/date-utils.ts` and is not surfaced via a shared entry point, which partially violates the plan.

   **Requested fix:** Add an appropriate named export, e.g.:

   ```ts
   // src/index.ts
   export { getWeekDifference } from "./engine/date-utils.js";
   ```

   or via whatever central utilities barrel this repo uses, consistent with existing patterns.

## Suggestions

1. **Consider hoisting `MS_PER_WEEK` to module scope**

   `src/engine/date-utils.ts:12-14`:

   ```ts
   export function getWeekDifference(a: Date, b: Date): number {
     const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
     const diffMs = Math.abs(a.getTime() - b.getTime());
   ```

   Since `MS_PER_WEEK` is a constant, you could define it once at module level to avoid reallocation and make it easier to reuse:

   ```ts
   const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

   export function getWeekDifference(a: Date, b: Date): number {
     const diffMs = Math.abs(a.getTime() - b.getTime());
     return Math.floor(diffMs / MS_PER_WEEK);
   }
   ```

2. **Minor JSDoc precision**

   The comment in `src/engine/date-utils.ts:1-10` is clear and matches behavior. You might add one explicit sentence that it operates on “elapsed time” rather than calendar weeks to avoid any confusion for future readers, but this is optional.

## Nits

1. **Relative import extension in tests**

   `src/engine/date-utils.test.ts:2`:

   ```ts
   import { getWeekDifference } from "./date-utils.js";
   ```

   If the project convention elsewhere is to import TypeScript files without `.js` (e.g., `./date-utils`), you may want to align with that. If the repo is consistently using `.js` extensions in TS source imports to support ESM with TS pathing, then this is fine as-is; just ensure it matches existing style.
