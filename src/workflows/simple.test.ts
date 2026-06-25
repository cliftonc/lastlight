import { describe, expect, it } from "vitest";
import { workflowScopedTaskId, PER_TARGET_REUSE_WORKFLOWS, PREPOPULATE_SYNTH_WORKFLOWS } from "./simple.js";

const RUN = "abcdef12-3456-7890-abcd-ef1234567890";

describe("workflowScopedTaskId", () => {
  it("keys pr-review / pr-fix by (repo, PR) with no run suffix so they reuse one workspace", () => {
    for (const wf of PER_TARGET_REUSE_WORKFLOWS) {
      const a = workflowScopedTaskId("drizzle-cube", 918, wf, RUN);
      const b = workflowScopedTaskId("drizzle-cube", 918, wf, "different-run-id");
      expect(a).toBe(`drizzle-cube-918-${wf}`);
      // Two separate runs on the same PR resolve to the same dir → reuse.
      expect(a).toBe(b);
    }
  });

  it("keeps the run suffix for build so each run gets a fresh workspace", () => {
    const id = workflowScopedTaskId("drizzle-cube", 918, "build", RUN);
    expect(id).toBe("drizzle-cube-918-build-abcdef12");
  });

  it("keeps the run suffix for repo-scoped (no number) workflows", () => {
    const id = workflowScopedTaskId("drizzle-cube", undefined, "health", RUN);
    expect(id).toBe("drizzle-cube-health-abcdef12");
  });

  it("does not reuse when a per-PR workflow has no number", () => {
    const id = workflowScopedTaskId("drizzle-cube", undefined, "pr-review", RUN);
    expect(id).toBe("drizzle-cube-pr-review-abcdef12");
  });
});

describe("PREPOPULATE_SYNTH_WORKFLOWS", () => {
  it("includes verify and qa-test so their browser-QA screenshots harvest correctly", () => {
    // The harvest fix hinges on these pre-populating like build (cwd = repo
    // root), so server-mode artifacts land where serverArtifacts() reads them.
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("verify")).toBe(true);
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("qa-test")).toBe(true);
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("build")).toBe(true);
  });

  it("does not pre-populate read-only scan workflows that clone in-session", () => {
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("triage")).toBe(false);
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("answer")).toBe(false);
  });
});
