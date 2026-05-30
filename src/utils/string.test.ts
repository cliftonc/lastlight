import { describe, expect, it } from "vitest";
import { truncateMiddle } from "./string";

describe("truncateMiddle", () => {
  it("returns short strings unchanged when length is less than max", () => {
    const text = "short";
    const result = truncateMiddle(text, 10);
    expect(result).toBe(text);
  });

  it("returns exact-length strings unchanged when length equals max", () => {
    const text = "exact";
    const result = truncateMiddle(text, text.length);
    expect(result).toBe(text);
  });

  it("truncates long strings in the middle with an ellipsis and respects max length", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const max = 10;
    const result = truncateMiddle(text, max);

    expect(result.length).toBeLessThanOrEqual(max);
    expect(result).toContain("…");
  });

  it("returns empty string when max is less than or equal to zero", () => {
    expect(truncateMiddle("abc", 0)).toBe("");
    expect(truncateMiddle("abc", -5)).toBe("");
  });

  it("returns a single ellipsis when max is 1 or 2", () => {
    expect(truncateMiddle("abcdef", 1)).toBe("…");
    expect(truncateMiddle("abcdef", 2)).toBe("…");
  });
});
