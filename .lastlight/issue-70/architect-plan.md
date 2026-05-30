## Problem Statement

The repo needs a new pure utility `truncateMiddle(text: string, max: number): string` that shortens strings by inserting a single Unicode ellipsis (`…`) in the middle when `text.length > max`, ensuring the result length is at most `max`. The function should live in an appropriate existing utilities module under `src/` and be exported for reuse, with a dedicated Vitest test file covering passthrough and truncation behavior. The change must be minimal and compatible with the existing TypeScript and Vitest setup (tests run via `npm test`, as per `README.md` and the guardrails description).

## Summary of What Needs to Change

- Introduce a new string helper `truncateMiddle` in an existing shared utilities file under `src/`, or create a small `string`-oriented utility module if a clear location exists.
- Export the function from that module so other parts of the codebase can import it.
- Add a Vitest test file for `truncateMiddle`, validating:
  - Short string passthrough (no truncation when `text.length < max`).
  - Exact-length passthrough (`text.length === max`).
  - Middle truncation behavior when `text.length > max`, including that:
    - The returned string length is `<= max`.
    - It contains a single `…` character, with both a non-empty prefix and suffix taken from the original.
- Run `npm test` to ensure the full suite still passes; acknowledge that `npm run lint` and `npm run typecheck` are not wired at the root.

## Files to Modify

(Exact filenames to be confirmed by the executor, based on the existing utilities layout.)

- `src/<some-utils-file>.ts`
  - Add the `truncateMiddle` implementation.
  - Export it (named export).
  - Keep the style consistent with nearby utilities (TypeScript types, pure functions, no side effects).
- `src/<some-utils-file>.test.ts` or `src/<string-utils>.test.ts` (new)
  - Add focused Vitest tests for `truncateMiddle`.
  - If there is no existing suitable test file, create a new one aligned with how other utility tests are named and located (e.g., alongside the source file).

The executor should first scan `src/` for an existing general-purpose utilities module (e.g., `util.ts`, `string-utils.ts`, or similar). If there is a clear, shared utility file, that’s the right place; otherwise, a new `src/utils/string.ts` (and `.test.ts`) would be appropriate, but this must follow current project conventions.

## Implementation Approach

1. **Locate the utilities module**
   - Search under `src/` for a file that already houses small pure helpers (e.g., via filename patterns `*util*`, or by browsing `src/`).
   - Prefer adding `truncateMiddle` to a generic string/utility module rather than creating a new top-level file, unless there is no obvious existing home.

2. **Design the `truncateMiddle` semantics**
   - Inputs: `text: string`, `max: number`.
   - Behavior:
     - If `max <= 0`, returning an empty string is the safest and simplest behavior; document this in a comment or tests.
     - If `text.length <= max`, return `text` unchanged.
     - If `max === 1`, consider:
       - Either return `text[0]` (first character) or `…`; choose one behavior and test for it. For simplicity and predictability, returning the first character may be preferable.
     - For `max >= 2` and `text.length > max`:
       - Reserve 1 character for the ellipsis; the remaining `max - 1` characters are to be split between the prefix and suffix.
       - One reasonable split:
         - `const ellipsis = '…';`
         - `const remaining = max - ellipsis.length;`
         - `const prefixLength = Math.ceil(remaining / 2);`
         - `const suffixLength = Math.floor(remaining / 2);`
       - Compute:
         - `const start = text.slice(0, prefixLength);`
         - `const end = text.slice(text.length - suffixLength);`
       - Return: `start + ellipsis + end`.
       - This guarantees:
         - A single ellipsis in the middle.
         - Total length `<= max` (exactly `max` when `text.length` is large enough).
         - Non-empty prefix and suffix when `max >= 3`.

3. **Implement `truncateMiddle`**
   - In the chosen utilities file (e.g., `src/utils/string.ts` or similar), add:

     ```ts
     export function truncateMiddle(text: string, max: number): string {
       if (max <= 0) return '';
       if (text.length <= max) return text;
       if (max === 1) return text[0]; // or '…', but pick one and test it

       const ellipsis = '…';
       const remaining = max - ellipsis.length;
       if (remaining <= 0) {
         // degenerate case if max === 1 and above branch changes; keep for safety
         return ellipsis;
       }

       const prefixLength = Math.ceil(remaining / 2);
       const suffixLength = Math.floor(remaining / 2);

       const start = text.slice(0, prefixLength);
       const end = text.slice(text.length - suffixLength);

       return `${start}${ellipsis}${end}`;
     }
     ```

   - Ensure the function is exported (named export).
   - If the project uses a barrel file (e.g., `src/index.ts`) to re-export helpers, add `truncateMiddle` there as well if that matches current patterns.

4. **Add Vitest tests**
   - Create or extend the corresponding test file under `src/` (e.g., `src/utils/string.test.ts`).
   - Import the function:

     ```ts
     import { truncateMiddle } from './string'; // adjust path to match actual file
     ```

   - Add tests:

     - **Short string passthrough**:

       ```ts
       it('returns the original string when shorter than max', () => {
         expect(truncateMiddle('hello', 10)).toBe('hello');
       });
       ```

     - **Exact-length passthrough**:

       ```ts
       it('returns the original string when length equals max', () => {
         const text = 'abcdefghij'; // length 10
         expect(truncateMiddle(text, 10)).toBe(text);
       });
       ```

     - **Middle truncation**:

       ```ts
       it('truncates in the middle when text is longer than max', () => {
         const text = 'abcdefghijklmnopqrstuvwxyz';
         const max = 10;
         const result = truncateMiddle(text, max);

         expect(result.length).toBeLessThanOrEqual(max);
         expect(result).toContain('…');

         const [start, end] = result.split('…');
         expect(start.length).toBeGreaterThan(0);
         expect(end.length).toBeGreaterThan(0);
       });
       ```

     - Optionally, add tests for edge cases such as `max <= 0` and `max === 1` to lock in the chosen behavior.

   - Keep tests focused as requested; avoid coupling to unrelated functionality.

5. **Align with project conventions**
   - Match existing import/export style, file naming conventions (`.test.ts` vs `.spec.ts`), and Vitest usage seen in other `src/**/*.test.ts` files.
   - Use TypeScript types consistently (no `any`).

6. **Verification**
   - Run the full test suite:

     ```bash
     npm test
     ```

   - Confirm it passes and no new tests are flaky or slow.

## Risks and Edge Cases

- **Edge values of `max`**:
  - `max <= 0`: Must choose deterministic behavior (plan suggests returning `''`), and test it if used.
  - `max === 1`: Needs a clear contract (return first character vs ellipsis). Not specified in the issue; the executor should pick a behavior and document via tests.
- **Unicode and graphemes**:
  - The implementation uses JavaScript `string.length` and `slice`, which count UTF-16 code units. This is acceptable for a minimal change but not perfect for complex grapheme clusters (e.g., emojis). The issue statement doesn’t require grapheme-aware truncation, so this is an acceptable trade-off.
- **Location of the utility**:
  - Placing `truncateMiddle` in a non-ideal module might require refactoring later. The executor should carefully choose a sensible existing utils location consistent with project structure.
- **Barrel exports**:
  - If other code imports helpers from a central index (e.g., `src/index.ts`), failing to re-export `truncateMiddle` there could make it harder to use. Executor should check and, if appropriate, add it.

## Test Strategy

- Primary command:
  - `npm test`  
    - Uses Vitest (`vitest run`) with `vitest.config.ts`, per guardrails.
- No root `lint` or `typecheck` scripts are currently wired:
  - `npm run lint` → expected to fail with “Missing script: lint”.
  - `npm run typecheck` → expected to fail with “Missing script: typecheck”.
- Optional (dashboard workspace only, if changes ever touch it — they do not in this issue):
  - `cd dashboard && npx tsc -b` (not required for this utility addition).

## Estimated Complexity

- **Complexity: simple**

The change is confined to adding one small pure helper and its tests, with no impact on external APIs, configuration, or runtime behavior beyond providing a new utility.