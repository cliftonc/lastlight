# Reviewer verdict (cycle 2)

Verdict: REQUEST_CHANGES

### Critical

1. **New utility is imported in `src/index.ts` but not exported**  
   - File: `src/index.ts`  
   - The plan calls for "re-export the new function so it’s readily available" and specifically suggests:
     ```ts
     export { getWeekDifference } from "./engine/date-utils";
     ```
   - The diff instead adds:
     ```ts
     import { getWeekDifference } from "./engine/date-utils.js";
     ```
     but never uses or re-exports `getWeekDifference`.
   - This has two problems:
     - A dead import in the main entry file.
     - The function is not actually exposed from the public API as intended.
   - Recommended fix:
     - Remove the unused import and add a named export, e.g.:
       ```ts
       // Remove this line:
       // import { getWeekDifference } from "./engine/date-utils.js";

       // Add near existing exports at the bottom of index.ts:
       export { getWeekDifference } from "./engine/date-utils.js";
       ```
     - Or, if the project’s pattern is to aggregate exports in a specific block, follow the existing style but ensure it is a true export, not just an unused import.

### Important

_No additional important issues beyond the above export problem._

### Suggestions

1. **Consider marking `MS_PER_WEEK` as `export` if it’s useful for tests or other helpers**  
   - File: `src/engine/date-utils.ts:1`  
   - Currently:
     ```ts
     const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
     ```
   - This is fine as-is. If other date utilities ever need a week constant, exporting it could prevent duplication:
     ```ts
     export const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
     ```
   - Not required for this issue, just a potential reuse improvement.

2. **Align test helper visibility with future reuse needs**  
   - File: `src/engine/date-utils.test.ts:4-6`  
   - The `utcDate` helper is local to this test file. If other tests end up needing UTC-specific dates, you may eventually want to extract a shared test helper, but for now this is acceptable and keeps scope small.

### Nits

1. **Docstring tweak for clarity**  
   - File: `src/engine/date-utils.ts:3-13`  
   - The comment is already good. To match the plan’s language exactly, you might explicitly state "returns a non-negative integer number of whole weeks between two instants in time." This is purely editorial.

2. **Optional: add a brief inline note about internal vs public use**  
   - If the maintainers ultimately decide not to expose this from `src/index.ts`, a short comment in `date-utils.ts` stating that it’s intended as an internal scheduling helper could help future contributors. This is dependent on project conventions.
