import { describe, it, expect } from "vitest";
import { humanDurationBetween } from "./date-helpers.js";

describe("humanDurationBetween", () => {
  it("formats basic ranges using ISO strings", () => {
    expect(
      humanDurationBetween(
        "2024-01-01T00:00:00Z",
        "2024-01-01T00:00:30Z",
      ),
    ).toBe("30s");

    expect(
      humanDurationBetween(
        "2024-01-01T00:00:00Z",
        "2024-01-01T00:01:00Z",
      ),
    ).toBe("1m");

    expect(
      humanDurationBetween(
        "2024-01-01T00:00:00Z",
        "2024-01-01T01:00:00Z",
      ),
    ).toBe("1h");

    expect(
      humanDurationBetween(
        "2024-01-01T00:00:00Z",
        "2024-01-03T00:00:00Z",
      ),
    ).toBe("2d");

    expect(
      humanDurationBetween(
        "2024-01-01T00:00:00Z",
        "2024-01-01T00:00:00Z",
      ),
    ).toBe("0s");
  });

  it("is independent of argument order", () => {
    const a = "2024-01-01T00:00:00Z";
    const b = "2024-01-01T01:00:00Z";

    expect(humanDurationBetween(a, b)).toBe("1h");
    expect(humanDurationBetween(b, a)).toBe("1h");
  });

  it("supports Date instances", () => {
    const start = new Date("2024-01-01T00:00:00Z");
    const end = new Date("2024-01-01T00:00:45Z");

    expect(humanDurationBetween(start, end)).toBe("45s");
  });

  it("treats numbers as unix seconds", () => {
    const start = 1_700_000_000; // seconds
    const end = 1_700_000_060; // +60 seconds

    expect(humanDurationBetween(start, end)).toBe("1m");
  });

  it("handles mixed input types symmetrically", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const iso = "2024-01-01T00:00:30Z";

    expect(humanDurationBetween(date, iso)).toBe("30s");
    expect(humanDurationBetween(iso, date)).toBe("30s");
  });

  it("returns an explicit marker for invalid input", () => {
    const valid = "2024-01-01T00:00:00Z";

    expect(humanDurationBetween(null, new Date(valid))).toBe(
      "invalid date range",
    );
    expect(humanDurationBetween("", valid)).toBe("invalid date range");
    expect(humanDurationBetween("not-a-date", valid)).toBe(
      "invalid date range",
    );
    expect(humanDurationBetween("not-a-date", "also-bad")).toBe(
      "invalid date range",
    );
  });
});
