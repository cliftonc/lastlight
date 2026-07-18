import { describe, it, expect } from "vitest";
import { getWorkflow, getCronWorkflows, getWorkflowByIntent } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in dependabot-pr-merge workflow + its cron sweep.
 * Loads the REAL workflows/ dir (like golden-build.test.ts) so a schema break or
 * an accidental rewiring of the intent / cron is caught.
 */
describe("dependabot-pr-merge — built-in workflow + cron", () => {
  it("loads with a single assess phase and the dependabot-pr-merge intent", () => {
    const def = getWorkflow("dependabot-pr-merge");
    expect(def.name).toBe("dependabot-pr-merge");
    expect(def.classification?.intent).toBe("dependabot-pr-merge");
    expect(def.phases.map((p) => p.name)).toEqual(["assess"]);
    expect(def.phases[0].prompt).toBe("prompts/dependabot-pr-merge.md");
  });

  it("is resolvable by intent (the router's deterministic pr.checks_passed route)", () => {
    expect(getWorkflowByIntent("dependabot-pr-merge")?.name).toBe("dependabot-pr-merge");
  });

  it("registers a scan cron that always runs (no webhooksEnabled gate)", () => {
    const cron = getCronWorkflows().find((c) => c.workflow === "dependabot-pr-merge");
    expect(cron).toBeDefined();
    expect(cron!.context?.mode).toBe("scan");
    // Intentionally NOT gated on webhooksEnabled — the sweep runs alongside the
    // real-time pr.checks_passed webhook (auto-merge is idempotent).
    expect(cron!.condition?.unless).toBeUndefined();
  });
});
