import { describe, it, expect } from "vitest";
import { weeksBetween } from "./date.js";

describe("weeksBetween", () => {
  it("returns 0 for the same date instance", () => {
    const date = new Date("2024-01-01T00:00:00Z");
    expect(weeksBetween(date, date)).toBe(0);
  });

  it("returns 0 for dates less than one week apart", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-06T23:59:59Z");
    expect(weeksBetween(a, b)).toBe(0);
    expect(weeksBetween(b, a)).toBe(0);
  });

  it("returns 1 for exactly one week apart, regardless of order", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-08T00:00:00Z");
    expect(weeksBetween(a, b)).toBe(1);
    expect(weeksBetween(b, a)).toBe(1);
  });

  it("handles multiple full weeks", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-15T00:00:00Z");
    expect(weeksBetween(a, b)).toBe(2);
  });

  it("truncates partial weeks", () => {
    const a = new Date("2024-01-01T00:00:00Z");
    const b = new Date("2024-01-15T11:59:59Z");
    // 14 days + 11h59m59s -> still 2 full weeks when truncated
    expect(weeksBetween(a, b)).toBe(2);
  });

  it("handles large differences in time", () => {
    const a = new Date("2000-01-01T00:00:00Z");
    const b = new Date("2024-01-01T00:00:00Z");
    const diffMs = Math.abs(b.getTime() - a.getTime());
    const weeks = Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000));
    expect(weeksBetween(a, b)).toBe(weeks);
  });

  it("is stable across DST transitions using UTC times", () => {
    // Use a range that crosses a typical DST change (e.g., US 2024-03-10)
    const beforeDst = new Date("2024-03-01T00:00:00Z");
    const afterDst = new Date("2024-03-22T00:00:00Z");
    // 21 days difference -> 3 weeks
    expect(weeksBetween(beforeDst, afterDst)).toBe(3);
  });
});
