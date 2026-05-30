## Problem Statement

The repo currently lacks a helper for safely shortening long strings in the middle. The issue requests a pure utility `truncateMiddle(text: string, max: number): string` that, when `text.length > max`, keeps the start and end of the string and inserts a single ellipsis (`…`) such that the final length is at most `max`; otherwise it returns `text` unchanged. The helper should live in a sensible existing `src/` utilities location and be exported, with focused Vitest tests ensuring short/exact strings pass through unchanged and long strings are truncated with an ellipsis and length constraint. The change should be minimal and keep the existing test suite passing (`npx vitest run`; see `CLAUDE.md` and `README.md` for dev/test conventions).

## Summary of What Needs to Change

- Identify or create an appropriate utilities module under `src/` to host general-purpose string helpers and define `truncateMiddle(text, max)`.
- Export `truncateMiddle` from that module (and any central index if appropriate) for reuse.
- Implement the truncation logic, including edge handling for very small `max` values.
- Add a dedicated Vitest test file under `src/` following existing test layout and naming conventions to cover:
  - Short-string passthrough (`text.length < max`).
  - Exact-length passthrough (`text.length === max`).
  - Middle truncation behavior for a clearly longer string, with assertions on length and presence of `…`.
- Run `npx vitest run` and (if used locally) `npx tsc -p tsconfig.json` to verify tests and types remain healthy.

## Files to Modify

1. **New or existing string utils module (to be confirmed by executor)**
   - Likely location: `src/engine/`, `src/admin/`, or a shared root such as `src/utils/` or `src/lib/` (none obvious from the tree; executor should search for existing small helpers).
   - Purpose:
     - Define `truncateMiddle(text: string, max: number): string`.
     - Export the function for use elsewhere.
   - Changes:
     - Implement the core algorithm.
     - Handle corner cases when `max` is smaller than a reasonable minimum.
     - Ensure the module is written in TypeScript and aligned with existing style.

2. **Export surface (if needed)**
   - Candidate: `src/index.ts` or another barrel file that aggregates utilities (e.g., a `src/engine/index.ts` or similar if it exists).
   - Purpose:
     - Re-export `truncateMiddle` so other parts of the codebase can import it consistently.
   - Changes:
     - Add an export line for the helper from the chosen utilities module.

3. **New test file**
   - Location: chosen to match patterns in `src/*.test.ts`, e.g.:
     - If the utility is placed at `src/engine/truncate-middle.ts`, tests should go to `src/engine/truncate-middle.test.ts`.
     - If a shared utils folder is created (e.g. `src/utils/string.ts`), place tests alongside: `src/utils/string.test.ts`.
   - Purpose:
     - Cover the requested scenarios and any edge behaviors.
   - Changes:
     - Import `truncateMiddle`.
     - Define Vitest tests (`describe` / `it` or `test`) with clear names and minimal setup.

## Implementation Approach

1. **Locate or define the utilities home**
   - Inspect `src/` for existing generic helpers:
     - Check for files like `src/utils.ts`, `src/helpers.ts`, `src/lib/`, or small pure functions (e.g., search via `mastra_workspace_grep` for simple exported functions used widely).
   - Decision:
     - If there is an existing general-purpose utility module (e.g. `src/engine/utils.ts` or similar), add `truncateMiddle` there.
     - If none is suitable, create a small dedicated module, e.g.:
       - `src/utils/string.ts` (preferred if similar patterns exist).
       - Or `src/utils/truncate-middle.ts` if they keep utilities highly focused.
   - Ensure the file name and directory structure match the project’s style (kebab-case vs camelCase, etc., by copying existing patterns in `src/`).

2. **Design the `truncateMiddle` behavior**
   - Signature: `export function truncateMiddle(text: string, max: number): string`.
   - Base cases:
     - If `max <= 0`: safest is to return an empty string (or possibly `''` with a short JSDoc comment noting behavior). This is an edge case not specified but prevents negative slicing issues.
     - If `text.length <= max`: return `text` unchanged.
     - If `max === 1`: returning `'…'` is reasonable (1-character output honoring `max` while preserving the “truncated” signal).
     - If `max === 2`: either `'…'` or a 2-char combination; a simple rule is to still return `'…'` (1 char ≤ 2) to avoid confusing output.
   - General truncation when `text.length > max` and `max >= 3`:
     - Reserve 1 character for the ellipsis, so the remaining `max - 1` characters must be split between the start and end.
     - Example split:
       - `const remaining = max - 1;`
       - `const frontLen = Math.ceil(remaining / 2);`
       - `const backLen = Math.floor(remaining / 2);`
     - Compute:
       - `const start = text.slice(0, frontLen);`
       - `const end = text.slice(text.length - backLen);`
       - `return start + '…' + end;`
     - This ensures `start.length + 1 + end.length === max` and always `<= max`.

3. **Implement the utility**
   - In the chosen module, add:
     - A brief JSDoc describing behavior, including edge cases on small `max`.
     - The implementation as designed above.
   - Ensure TypeScript types are explicit:
     - Inputs `text: string`, `max: number`.
     - Return type `string`.
   - Make sure the function is exported from the module.

4. **Wire up exports where appropriate**
   - If the project uses a central export barrel (e.g. `src/index.ts` aggregates common exports), add:
     - `export { truncateMiddle } from './<path-to-utils>';`
   - If utilities are meant to be imported directly from their file (no barrel), no change needed beyond the function’s own `export`.

5. **Create targeted tests**
   - Choose the test location to align with existing tests in `src/`:
     - For example, if the helper is in `src/utils/string.ts`, tests go to `src/utils/string.test.ts` to mirror patterns like `src/admin/auth.ts` vs `src/admin/auth.test.ts` (seen in tree list).
   - Write tests using Vitest:
     - Import `{ truncateMiddle }` from the correct relative path.
     - Tests:
       1. **Short string passthrough**
          - Example: `truncateMiddle('short', 10)` should return `'short'`.
          - Assert equality.
       2. **Exact-length passthrough**
          - Example: `truncateMiddle('exact', 5)` should return `'exact'` (length exactly equals `max`).
       3. **Middle truncation**
          - Use a longer string, e.g. `'abcdefghijklmnopqrstuvwxyz'` with `max = 10`.
          - Assert:
            - `const result = truncateMiddle(long, 10);`
            - `expect(result.length).toBeLessThanOrEqual(10);`
            - `expect(result).toContain('…');`
            - Optionally assert that the prefix/suffix align with the algorithm if you want stricter behavior guarantees (e.g. `expect(result.startsWith('abc'))`, `expect(result.endsWith('xyz'))` depending on split).
       4. **Edge cases (optional but recommended)**
          - `max <= 0` returns empty string.
          - `max === 1` returns `'…'`.
       - Keep tests focused and small as requested; don’t overfit to internal implementation details (e.g., exact split lengths) unless maintainers prefer strictness.

6. **Run tests and (optional) typecheck**
   - From repo root:
     - Run full test suite: `npx vitest run`.
   - Since the project uses TypeScript but has no dedicated `typecheck` script, the executor can optionally run:
     - `npx tsc -p tsconfig.json`
   - Ensure both complete without errors and no other tests regress.

## Risks and Edge Cases

- **Very small `max` values**:
  - `max <= 0`: specification is silent; returning `''` is predictable but should be covered by tests or at least documented in JSDoc.
  - `max === 1` or `max === 2`: must avoid negative slice lengths; a simple rule (e.g. always `'…'` when `max <= 2`) ensures safety.
- **Non-ASCII / multi-byte characters**:
  - JavaScript string length counts UTF-16 code units, not grapheme clusters; this is standard in the codebase and acceptable here given the scope. Just ensure the ellipsis is the single character `…` (U+2026) consistently.
- **Unexpected input types**:
  - The function is typed `string`/`number`, and the rest of the codebase is TypeScript; no explicit runtime coercion is necessary, but the executor should avoid adding non-standard assertions that complicate usage.
- **API expectations**:
  - Caller expectations about how much of the start/end is kept are not specified; tests should focus on length and presence of `…`, not exact splitting, to allow future adjustment if needed.

## Test Strategy

- Primary test command (from repo root):
  - `npx vitest run`
- Optional typecheck (manual, since there’s no npm script):
  - `npx tsc -p tsconfig.json`

## Estimated Complexity

- **Simple**: small, self-contained utility function plus one focused test file, with no impacts on broader architecture.