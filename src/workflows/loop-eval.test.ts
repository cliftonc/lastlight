import { describe, it, expect } from "vitest";
import { evalUntilExpression } from "./loop-eval.js";

describe("evalUntilExpression — output.contains", () => {
  it("returns true when output contains the target string", () => {
    expect(evalUntilExpression("output.contains('APPROVED')", { output: "VERDICT: APPROVED" })).toBe(true);
  });

  it("returns false when output does not contain the target string", () => {
    expect(evalUntilExpression("output.contains('APPROVED')", { output: "REQUEST_CHANGES" })).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(evalUntilExpression("output.contains('approved')", { output: "APPROVED" })).toBe(false);
  });

  it("works with double-quoted strings", () => {
    expect(evalUntilExpression('output.contains("PASS")', { output: "All tests PASS" })).toBe(true);
  });
});

describe("evalUntilExpression — equality (==)", () => {
  it("returns true when context variable equals value", () => {
    expect(evalUntilExpression("verdict == 'APPROVED'", { output: "", verdict: "APPROVED" })).toBe(true);
  });

  it("returns false when context variable does not equal value", () => {
    expect(evalUntilExpression("verdict == 'APPROVED'", { output: "", verdict: "REQUEST_CHANGES" })).toBe(false);
  });

  it("works with double-quoted value", () => {
    expect(evalUntilExpression('status == "done"', { output: "", status: "done" })).toBe(true);
  });

  it("returns false when variable is absent from context", () => {
    expect(evalUntilExpression("missing == 'value'", { output: "" })).toBe(false);
  });
});

describe("evalUntilExpression — inequality (!=)", () => {
  it("returns true when context variable does not equal value", () => {
    expect(evalUntilExpression("verdict != 'FAILED'", { output: "", verdict: "APPROVED" })).toBe(true);
  });

  it("returns false when context variable equals the value", () => {
    expect(evalUntilExpression("verdict != 'FAILED'", { output: "", verdict: "FAILED" })).toBe(false);
  });

  it("returns false when variable is absent from context", () => {
    expect(evalUntilExpression("missing != 'value'", { output: "" })).toBe(false);
  });
});

describe("evalUntilExpression — invalid / unrecognised expressions", () => {
  it("returns false for an empty string", () => {
    expect(evalUntilExpression("", { output: "anything" })).toBe(false);
  });

  it("returns false for an unrecognised expression form", () => {
    expect(evalUntilExpression("output > 5", { output: "10" })).toBe(false);
  });

  it("returns false for a bare variable name", () => {
    expect(evalUntilExpression("verdict", { output: "", verdict: "APPROVED" })).toBe(false);
  });
});
