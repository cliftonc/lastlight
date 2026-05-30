# Executor summary

Changes made:

1. Added the new utility:

- `src/util.ts`
  ```ts
  export function truncateMiddle(text: string, max: number): string {
    if (max <= 0) return "";
    if (text.length <= max) return text;

    const ellipsis = "…";

    if (max === 1) return ellipsis;

    const remaining = max - ellipsis.length; // space for prefix+suffix
    const prefixLength = Math.ceil(remaining / 2);
    const suffixLength = Math.floor(remaining / 2);

    const prefix = text.slice(0, prefixLength);
    const suffix = text.slice(text.length - suffixLength);

    return prefix + ellipsis + suffix;
  }
  ```

2. Added focused vitest tests colocated with the util:

- `src/util.test.ts`
  ```ts
  import { describe, it, expect } from "vitest";
  import { truncateMiddle } from "./util.js";

  describe("truncateMiddle", () => {
    it("returns short strings unchanged when below max", () => {
      const text = "short";
      const max = 10;

      const result = truncateMiddle(text, max);

      expect(result).toBe(text);
    });

    it("returns exact-length strings unchanged", () => {
      const text = "exact-len";
      const max = text.length;

      const result = truncateMiddle(text, max);

      expect(result).toBe(text);
    });

    it("truncates long strings in the middle with an ellipsis", () => {
      const text = "abcdefghijklmnopqrstuvwxyz";
      const max = 10;

      const result = truncateMiddle(text, max);

      expect(result.length).toBeLessThanOrEqual(max);
      expect(result).toContain("…");

      const ellipsis = "…";
      const remaining = max - ellipsis.length;
      const expectedPrefixLength = Math.ceil(remaining / 2);
      const expectedSuffixLength = Math.floor(remaining / 2);

      expect(result.startsWith(text.slice(0, expectedPrefixLength))).toBe(true);
      expect(
        result.endsWith(text.slice(text.length - expectedSuffixLength)),
      ).toBe(true);
    });

    it("handles small max values", () => {
      expect(truncateMiddle("abc", 1)).toBe("…");
      expect(truncateMiddle("abc", 0)).toBe("");
    });
  });
  ```

Behavior notes:

- If `max <= 0`, returns `""`.
- If `text.length <= max`, returns `text` unchanged.
- Uses a single `…` and splits remaining characters as evenly as possible between prefix and suffix.
- For `max === 1`, returns just `…`.

Verification:

- Tests (`npm test`):

  - All test files passed, including the new `src/util.test.ts`.
  - Summary: `Test Files 28 passed (28)`; `Tests 471 passed | 1 todo (472)`.

- Typecheck (`npx tsc --noEmit`):

  - Completed with no TypeScript errors after updating the test import to use `./util.js` to match `node16` module resolution.
