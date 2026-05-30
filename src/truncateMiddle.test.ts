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
    expect(result.endsWith(text.slice(text.length - expectedSuffixLength))).toBe(true);
  });

  it("handles small max values", () => {
    expect(truncateMiddle("abc", 1)).toBe("…");
    expect(truncateMiddle("abc", 0)).toBe("");
  });
});
