# Reviewer verdict (cycle 3)

Verdict: REQUEST_CHANGES

**Critical / Important**

1. **Missing barrel/public export (plan item 2 & 7)**  
   - The plan explicitly calls for re-exporting the utility from a central module (likely `src/index.ts`) so it’s easily reusable.  
   - The diff only adds `src/engine/date-utils.ts` and `src/engine/date-utils.test.ts`; there is no change to `src/index.ts` or any other barrel.  
   - Without this, the function is not yet “wired up” per the plan, and its discoverability is reduced.  
   - Please add a named export, e.g. in `src/index.ts`:
     ```ts
     // src/index.ts
     export { getWeekDifference } from "./engine/date-utils.js";
     ```
     (Adjust the relative path / `.js` suffix to match existing exports style.)

**Suggestions**

1. **Minor DST test clarity** (`src/engine/date-utils.test.ts:43-63`)  
   - The DST test is good and uses UTC correctly. It might be worth a brief comment that `beforeDst`/`afterDst` are created via `utcDate` and thus represent fixed instants, independent of local DST rules, just to reinforce why this is safe.

2. **Optional type/generalization** (`src/engine/date-utils.ts:14`)  
   - The plan mentioned optionally supporting `Date | string | number` via a normalizer. Current implementation sticks to `Date`, which is acceptable and keeps the scope tight.  
   - If there’s a pattern in this repo for accepting broader date-like inputs, consider a small internal helper:
     ```ts
     function toDate(d: Date | string | number): Date {
       return d instanceof Date ? d : new Date(d);
     }
     ```
     and adjust the signature accordingly. Not required by the plan, so this is optional.

3. **Exported constant vs. local constant** (`src/engine/date-utils.ts:1`)  
   - `MS_PER_WEEK` is currently module-private. If you anticipate future helpers needing it (e.g., month/week utilities), you could export it, but the plan doesn’t require this. Leaving it internal is fine and keeps API surface small.

**Nits**

1. **JSDoc wording** (`src/engine/date-utils.ts:3-12`)  
   - The comment already aligns well with the plan. You could add a short note like “Returns 0 when `a` and `b` are less than one full week apart” to mirror the explicit behavior used in tests, but this is purely cosmetic.

Overall, implementation and tests match the core logic and edge cases from the plan; the main gap is the missing public/barrel export. Once that’s added, the change will fully conform to the architect’s plan.
