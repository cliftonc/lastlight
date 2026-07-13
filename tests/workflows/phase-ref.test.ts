import { describe, it, expect } from "vitest";
import { PhaseRef } from "#src/workflows/phase-ref.js";

describe("PhaseRef.format — the single label authority", () => {
  it("pins the literal generated label strings", () => {
    expect(PhaseRef.review("reviewer").format()).toBe("reviewer");
    expect(PhaseRef.fix("reviewer", 1).format()).toBe("reviewer_fix_1");
    expect(PhaseRef.recheck("reviewer", 1).format()).toBe("reviewer_recheck_1");
    expect(PhaseRef.iter("reviewer", 1).format()).toBe("reviewer_iter_1");
    expect(PhaseRef.iterRetry("socratic", 7).format()).toBe("socratic_iter_7_retry");
  });
});

describe("PhaseRef.parse — round-trips generated labels back to base + kind", () => {
  it("parses each generated suffix", () => {
    expect(PhaseRef.parse("reviewer_fix_2")).toMatchObject({ base: "reviewer", kind: "fix", index: 2 });
    expect(PhaseRef.parse("reviewer_recheck_2")).toMatchObject({ base: "reviewer", kind: "recheck", index: 2 });
    expect(PhaseRef.parse("reviewer_iter_3")).toMatchObject({ base: "reviewer", kind: "iter", index: 3 });
    expect(PhaseRef.parse("socratic_iter_7_retry")).toMatchObject({ base: "socratic", kind: "retry", index: 7 });
  });

  it("does not mistake a plain iteration for a retry", () => {
    expect(PhaseRef.parse("socratic_iter_7")).toMatchObject({ base: "socratic", kind: "iter", index: 7 });
  });

  it("parses a bare declared name as a plain phase", () => {
    expect(PhaseRef.parse("reviewer")).toMatchObject({ base: "reviewer", kind: "phase" });
  });

  it("parses the dropped legacy reviewer_2 form as a plain phase (not a recheck)", () => {
    expect(PhaseRef.parse("reviewer_2")).toMatchObject({ base: "reviewer_2", kind: "phase" });
  });
});
