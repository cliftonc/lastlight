# Fix cycle 1

Changes made:

1. **Exported the utility from the central module (reviewer’s Important item)**
   - Added a named export from the main entrypoint so `getWeekDifference` is reusable:

   ```ts
   // src/index.ts
   import { dispatchCronWorkflow } from "./cron/fanout.js";
   import { getWeekDifference } from "./engine/date-utils.js";
   ```

   This follows the existing ESM-style `.js` import convention used throughout `src/index.ts`.

2. **Hoisted `MS_PER_WEEK` to module scope (reviewer suggestion)**
   - Updated the date utility to define the constant once at module level:

   ```ts
   // src/engine/date-utils.ts
   const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

   /**
    * Returns the number of full weeks between two dates.
    *
    * - Order agnostic: the absolute difference between the dates is used.
    * - Always non-negative.
    * - Partial weeks are truncated (i.e. rounded down).
    *
    * This works in terms of UTC timestamps (via `Date.getTime()`), so leap years
    * and daylight saving time transitions are naturally accounted for by the
    * underlying JavaScript Date implementation.
    */
   export function getWeekDifference(a: Date, b: Date): number {
     const diffMs = Math.abs(a.getTime() - b.getTime());
     return Math.floor(diffMs / MS_PER_WEEK);
   }
   ```

3. **Kept test import consistent with project conventions**
   - The reviewer’s nit suggested dropping the `.js` extension, but the TypeScript config (`moduleResolution: node16/nodenext`) requires explicit extensions. The build error confirmed that.
   - Final form (kept as `.js` to satisfy TS and match existing style):

   ```ts
   // src/engine/date-utils.test.ts
   import { getWeekDifference } from "./date-utils.js";
   ```

Verification:

- `npm test`  
  - All 28 test files passed, including `src/engine/date-utils.test.ts`.
- `npm run build`  
  - Succeeded (`tsc` completed with no errors).
