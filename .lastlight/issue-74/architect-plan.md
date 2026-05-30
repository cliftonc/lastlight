### Problem Statement

Issue [#74](https://github.com/cliftonc/lastlight/issues/74) asks for a “small, self-contained pure utility to format any date to `YYYY, MM, DD`.” There is currently no dedicated shared utility for this exact format (repo-level search shows no matches for `YYYY, MM, DD`). The codebase already contains TypeScript utilities and tests under `src/` (see high-level layout in `CLAUDE.md`:1–4, 51–70), so this formatter should live alongside existing utilities with proper typing and test coverage.

---

### Summary of What Needs to Change

- Add a new pure, side-effect-free date formatting utility that converts a date-like input into a string `"YYYY, MM, DD"` with zero-padded month and day.
- Ensure the utility accepts at least a `Date` instance; optionally support more input types if desired (but only if clearly defined).
- Add unit tests to validate correct formatting for:
  - Typical dates
  - Single-digit month/day (zero-padding behavior)
  - Edge cases like different time zones and invalid inputs (as appropriate).
- Export the utility from an appropriate barrel/module if the project uses one, so it is easy to reuse.

---

### Files to Modify

1. **New file:** `src/utils/formatDate.ts` (or analogous utility location)
   - Implement the `formatDateYYYYMMDD` (name can be finalized per repo conventions) function:
     - Input: at minimum a `Date` object.
     - Output: string in the exact format `"YYYY, MM, DD"`.
     - Contain clear TypeScript types and JSDoc for usage and behavior.

2. **New test file:** `src/utils/formatDate.test.ts`
   - Vitest tests validating:
     - Basic formatting.
     - Zero-padding behavior.
     - Handling of various date values (including boundary cases like Jan 1, Dec 31).
     - Behavior on invalid inputs, if the utility is defined to accept anything beyond `Date`.

3. **Optional (if a utilities barrel exists):** e.g. `src/utils/index.ts`
   - Re-export the new function to make it discoverable and easy to import across the codebase.

4. **Optional documentation touchpoint:** If there’s a central internal utilities description (none obvious from the initial scan), note the presence of this utility there for future contributors.

---

### Implementation Approach

1. **Decide input contract**
   - Keep it simple and predictable: accept `Date | string | number` only if you normalize clearly, otherwise stick to `Date` only.
   - To minimize ambiguity and surprises, prefer:
     ```ts
     export function formatDateYYYYMMDD(date: Date): string;
     ```
   - If extended support is requested later, it can be added in a backward-compatible way.

2. **Create the utility file**
   - Add `src/utils/formatDate.ts` (create `src/utils` directory if it doesn’t already exist).
   - Implement:
     - Guard: if `!(date instanceof Date) || isNaN(date.getTime())`, either:
       - Throw a `TypeError` with a clear message (simplest and safest), or
       - Return an empty string / `null` (only if the issue explicitly prefers that; since it doesn’t, throwing is better).
     - Extract `year`, `month`, `day`:
       ```ts
       const year = date.getFullYear();
       const month = String(date.getMonth() + 1).padStart(2, "0");
       const day = String(date.getDate()).padStart(2, "0");
       return `${year}, ${month}, ${day}`;
       ```
   - Include a brief JSDoc comment explaining:
     - It uses the date in the local time zone (since `getFullYear`/`getMonth`/`getDate` are local).
     - Input expectations and error behavior.

3. **Add tests**
   - Create `src/utils/formatDate.test.ts` with Vitest:
     - Import `describe`, `it`, `expect` from `vitest` and the utility function.
     - Test cases:
       1. **Standard date:**
          - `new Date(2024, 0, 15)` → `"2024, 01, 15"`.
       2. **Single-digit month/day padding:**
          - `new Date(2024, 0, 1)` → `"2024, 01, 01"`.
          - `new Date(2024, 8, 9)` → `"2024, 09, 09"`.
       3. **Different year range cases:**
          - Past date (e.g., `new Date(1999, 11, 31)`).
          - Far-future but valid date (e.g., `new Date(2100, 5, 10)`).
       4. **Invalid input behavior:**
          - `new Date(NaN)` should trigger the chosen error behavior.
          - If the function is typed as `Date`-only, you can still test runtime invalid date (NaN) but not non-Date types.
     - Keep tests pure and deterministic—avoid relying on system time.

4. **Export from utilities index if present**
   - Search for a utilities barrel file (e.g., `src/utils/index.ts`):
     - If present, add:
       ```ts
       export { formatDateYYYYMMDD } from "./formatDate";
       ```
     - If not present, skip this for now to avoid adding a new pattern.

5. **Light documentation / discoverability**
   - If there is a natural place to reference internal utilities (for developers), consider mentioning it briefly; otherwise, the function name and location are self-explanatory.

6. **Run tests and build**
   - Execute:
     - `npm test`
     - `npm run build`
   - Ensure both pass without TypeScript or runtime errors.

---

### Risks and Edge Cases

- **Time zone semantics:**  
  - Using `getFullYear`, `getMonth`, `getDate` yields local-time values, which might differ from UTC for `Date` instances constructed from ISO strings with time components near midnight UTC.
  - Since the issue doesn’t specify UTC vs local, local is acceptable, but document this in the JSDoc to avoid confusion.
- **Invalid dates:**  
  - `new Date(NaN)` or other malformed dates must be handled consistently; throwing a clear error is preferable to silently producing `"NaN, NaN, NaN"`.
- **Input scope creep:**  
  - Supporting strings/numbers directly can introduce parsing ambiguity and time zone confusion; keeping the contract as `Date` only keeps the function predictable and simple.

---

### Test Strategy

Commands to run (from repo root):

- Unit tests (Vitest, per guardrails report):
  - `npm test`
- Type checking / build:
  - `npm run build`  (runs `tsc`)

If any project-specific watch or dev-test commands are documented elsewhere, they are optional for this change; the two above are sufficient for verification.

---

### Estimated Complexity

- **Complexity:** simple  
  - One small utility function with straightforward logic and one corresponding test file.