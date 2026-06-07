# Fix cycle 2

- Removed the unused import of `getWeekDifference` from `src/index.ts`:
  - Deleted:
    ```ts
    import { getWeekDifference } from "./engine/date-utils.js";
    ```
- Re-exported the utility from the public API as intended by the architect plan, by adding at the bottom of `src/index.ts`:
  ```ts
  export { getWeekDifference } from "./engine/date-utils.js";
  ```

Verification:
- `npm test` → all tests passed (including `src/engine/date-utils.test.ts`).
- `npm run build` → TypeScript build succeeded.
