import { describe, it, expect } from "vitest";
import { setStep, upsertBefore, stepsFromPhases } from "./model.js";
import type { ProgressStep } from "./types.js";
import type { AgentWorkflowDefinition } from "../workflows/schema.js";

const steps = (): ProgressStep[] => [
  { key: "a", label: "A", status: "pending" },
  { key: "b", label: "B", status: "pending" },
  { key: "c", label: "C", status: "pending" },
];

describe("setStep", () => {
  it("updates status + detail for the matching key without mutating input", () => {
    const input = steps();
    const out = setStep(input, "b", "running", "working");
    expect(out[1]).toEqual({ key: "b", label: "B", status: "running", detail: "working" });
    // immutability
    expect(input[1].status).toBe("pending");
    expect(out).not.toBe(input);
  });

  it("preserves existing detail when none supplied", () => {
    const out1 = setStep(steps(), "a", "running", "step one");
    const out2 = setStep(out1, "a", "done");
    expect(out2[0].detail).toBe("step one");
    expect(out2[0].status).toBe("done");
  });

  it("appends an unknown key instead of dropping the transition", () => {
    const out = setStep(steps(), "z", "failed", "boom");
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual({ key: "z", label: "z", status: "failed", detail: "boom" });
  });
});

describe("upsertBefore", () => {
  it("inserts a new step before the named key", () => {
    const out = upsertBefore(steps(), { key: "x", label: "X", status: "running" }, "c");
    expect(out.map((s) => s.key)).toEqual(["a", "b", "x", "c"]);
  });

  it("updates in place when the key already exists", () => {
    const seeded = upsertBefore(steps(), { key: "x", label: "X", status: "running" }, "c");
    const out = upsertBefore(seeded, { key: "x", label: "X", status: "done", detail: "ok" }, "c");
    expect(out.filter((s) => s.key === "x")).toHaveLength(1);
    expect(out.find((s) => s.key === "x")?.status).toBe("done");
  });

  it("appends when beforeKey is omitted or not found", () => {
    expect(upsertBefore(steps(), { key: "x", label: "X", status: "running" }).map((s) => s.key)).toEqual([
      "a", "b", "c", "x",
    ]);
    expect(
      upsertBefore(steps(), { key: "y", label: "Y", status: "running" }, "nope").map((s) => s.key),
    ).toEqual(["a", "b", "c", "y"]);
  });
});

describe("stepsFromPhases", () => {
  const def = {
    kind: "build",
    name: "build",
    phases: [
      { name: "phase_0", label: "Context", type: "context" },
      { name: "guardrails", label: "Guardrails", type: "agent" },
      { name: "architect", type: "agent" },
    ],
  } as unknown as AgentWorkflowDefinition;

  it("skips context phases and uses labels (falling back to a title-cased name)", () => {
    const out = stepsFromPhases(def);
    expect(out.map((s) => s.key)).toEqual(["guardrails", "architect"]);
    expect(out[0].label).toBe("Guardrails");
    expect(out[1].label).toBe("Architect"); // derived from name
    expect(out.every((s) => s.status === "pending")).toBe(true);
  });

  it("marks completed phases as done (resume re-seeding)", () => {
    const out = stepsFromPhases(def, new Set(["guardrails"]));
    expect(out.find((s) => s.key === "guardrails")?.status).toBe("done");
    expect(out.find((s) => s.key === "architect")?.status).toBe("pending");
  });
});
