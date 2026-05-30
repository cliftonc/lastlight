## Problem Statement

The repo needs a new pure helper `truncateMiddle(text: string, max: number): string` that shortens long strings by keeping the start and end and inserting a single ellipsis character (`…`) in the middle so the result length is at most `max`. The helper should live in an appropriate existing `src/` utilities module and be exported from there, alongside a dedicated vitest file that covers short-string passthrough, exact-length passthrough, and truncation behavior. The change must integrate cleanly with the current TypeScript setup (`tsconfig.json`) and existing test infrastructure (`vitest.config.ts`) and keep `npm test` passing.

## Summary of What Needs to Change

- Locate an existing general-purpose string/utilities module under `src/` and add `truncateMiddle(text, max)` there, exporting it.
- Implement truncation logic that:
  - Returns `text` unchanged when `text.length <= max`.
  - When `text.length > max`, returns a string with a single `…` in the middle, preserving some prefix and suffix, and ensuring the total length is `<= max`.
- Add a new vitest test file in the matching test location (repo uses colocated `*.test.ts` files, e.g. `src/engine/classifier.test.ts`, `src/sandbox/docker-compose.test.ts`) that:
  - Verifies short strings are returned unchanged.
  - Verifies strings exactly at `max` length are returned unchanged.
  - Verifies truncation for a longer string, including:
    - `result.length <= max`
    - `result` contains `…`
    - Reasonable preservation of prefix/suffix.
- Run `npm test` and a TypeScript check (`npx tsc --noEmit`) to confirm everything still passes.

## Files to Modify

1. **`src/...` (existing utility module, to be identified)**
   - Find a central utility or string helper module under `src/` (e.g., `src/engine/…`, `src/workflows/…`, or a shared helper file) that already exports generic helpers.
   - Add the `truncateMiddle` function implementation and export it.
   - Rationale: keeps the helper in an existing shared location instead of creating a one-off file.

2. **New test file: `src/<utils-dir>/truncateMiddle.test.ts` (exact path to match chosen utils location)**
   - Add vitest tests for `truncateMiddle`.
   - Follow existing test style from nearby `*.test.ts` files (e.g. `src/engine/router.test.ts`, `src/sandbox/index.test.ts`).

3. **(If needed) `src/index.ts` or other barrel file**
   - If the project uses a top-level export surface for helpers and the utility module isn’t already reachable where needed, optionally export `truncateMiddle` via an existing barrel file.
   - Only do this if there’s a clear existing pattern; otherwise, keep the export local to the utility module.

## Implementation Approach

1. **Identify the right utils home**
   - Search under `src/` for existing utility-like modules:
     - For example, look for filenames such as `util.ts`, `utils.ts`, `string.ts`, or small helper modules used in multiple places.
   - Choose the most generic, shared, non-domain-specific module (e.g. not `github-tools.ts` or `docker.ts`) for this helper.
   - Confirm the module is in TypeScript and is part of the compiled sources (it will be, under `src/`).

2. **Design `truncateMiddle` behavior**
   - Function signature: `export function truncateMiddle(text: string, max: number): string`.
   - Base behavior:
     - If `max <= 0`, for safety return an empty string or `''` (this edge case isn’t in the spec but avoids odd behavior).
     - If `text.length <= max`, return `text` unchanged.
   - Truncation behavior when `text.length > max`:
     - Use a single ellipsis character: `const ellipsis = '…';`.
     - If `max <= 1`, return `ellipsis` (or a very minimal form), since there’s no room for prefix+suffix; still ensure `result.length <= max` by guarding:
       - If `max === 1`, return `ellipsis`.
       - If `max === 0`, return `''` (as above).
     - For `max >= 2` normal case:
       - Available length for non-ellipsis characters: `const remaining = max - ellipsis.length;` (this will be `max - 1`).
       - Split that between prefix and suffix:
         - `const prefixLength = Math.ceil(remaining / 2);`
         - `const suffixLength = Math.floor(remaining / 2);`
       - Construct the result:
         - `const prefix = text.slice(0, prefixLength);`
         - `const suffix = text.slice(text.length - suffixLength);`
         - `const truncated = prefix + ellipsis + suffix;`
       - Assert via tests that `truncated.length <= max`.
   - This scheme ensures:
     - Total length is at most `max`.
     - Prefix and suffix lengths are as balanced as possible.
     - Only one `…` appears.

3. **Implement `truncateMiddle` in the chosen utils file**
   - Add the implementation just described.
   - Export it using the pattern already used in that file (named export vs default).
   - If the utilities module has tests in a colocated `*.test.ts`, mirror that pattern for the new test file.

4. **Add tests**
   - Create `truncateMiddle.test.ts` alongside the utils file.
   - Import the helper from the same path it would be used by production code.
   - Use vitest’s `describe`, `it`/`test`, and `expect` mirroring repository conventions in existing tests like:
     - `src/engine/classifier.test.ts`
     - `src/workflows/dag.test.ts`
     - `src/sandbox/index.test.ts`
   - Add the following tests:
     1. **Short string passthrough**
        - Example:
          - `const text = 'short';`
          - `const max = 10;`
          - `expect(truncateMiddle(text, max)).toBe(text);`
     2. **Exact-length passthrough**
        - Example:
          - `const text = 'exact-len';`
          - `const max = text.length;`
          - `expect(truncateMiddle(text, max)).toBe(text);`
     3. **Middle truncation**
        - Use a longer string, e.g. `'abcdefghijklmnopqrstuvwxyz'` or a descriptive sentence.
        - Choose a `max` significantly smaller than `text.length`, e.g. `10` or `15`.
        - Assertions:
          - `const result = truncateMiddle(text, max);`
          - `expect(result.length).toBeLessThanOrEqual(max);`
          - `expect(result).toContain('…');`
          - Optionally:
            - `expect(result.startsWith(text.slice(0, /*expected prefix length*/)))` and
            - `expect(result.endsWith(text.slice(text.length - /*expected suffix length*/)))`,
            - computing expected lengths using the same formula as in the implementation.
     4. **Optional edge case test (if implemented)**
        - If you handle `max <= 1` specially, add:
          - `expect(truncateMiddle('abc', 1)).toBe('…');`
          - `expect(truncateMiddle('abc', 0)).toBe('');`
        - This keeps implementation and tests aligned, though the issue doesn’t require it.

5. **Ensure exports align with repo patterns**
   - If the utility module is itself imported via a barrel file or index (e.g., `src/engine/index.ts` or similar), verify that no additional export is needed.
   - Only add a new export into a barrel file if you see that all other utilities are surfaced that way and it makes sense for future reuse.

6. **Static checks and tests**
   - Run unit tests:
     - `npm test` (per guardrails: alias for `vitest run`).
   - Run TypeScript type checking:
     - `npx tsc --noEmit`.
   - If any type or test failures occur, adjust the function signature, exports, or test imports accordingly.

## Risks and Edge Cases

- **Choice of utils location**: Placing `truncateMiddle` in a too-specific module could create awkward dependencies later. Mitigate by choosing a clearly shared helper module (e.g. a generic `util.ts`).
- **Edge behavior for small `max` values**:
  - The issue doesn’t specify `max <= 1`, so behavior must be reasonable and tested if implemented.
- **Unicode/ellipsis handling**:
  - The ellipsis is a single code unit in JS (`'…'.length === 1`), so length calculations work as expected, but some environments may display it differently. This is acceptable here; tests will rely on `.length` from JS.
- **Off-by-one errors in prefix/suffix split**:
  - Incorrect calculations could push `result.length` over `max` or produce unbalanced truncations. Tests that explicitly assert length and prefix/suffix behavior mitigate this.

## Test Strategy

- Primary test command (from guardrails):
  - `npm test`  — runs vitest tests and must succeed.
- Type checking:
  - `npx tsc --noEmit` — run once after changes to confirm no TypeScript errors.
- Optional (if already used in this repo, not required by the issue):
  - `npm run build` — only if the repo commonly uses it to catch TS issues; not strictly necessary if `tsc --noEmit` succeeds.

## Estimated Complexity

- **Simple**: small, self-contained helper function with a single new test file and no cross-cutting changes.