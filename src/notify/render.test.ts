import { describe, it, expect } from "vitest";
import { renderProgress, STATUS_EMOJI } from "./render.js";
import type { ProgressModel } from "./types.js";

describe("renderProgress", () => {
  const model: ProgressModel = {
    title: "build for #18",
    subtitle: "Add retry to fetch",
    meta: ["Branch: [`lastlight/18`](https://example/tree/lastlight/18)"],
    steps: [
      { key: "guardrails", label: "Guardrails", status: "done", detail: "READY" },
      { key: "architect", label: "Architect", status: "running" },
      { key: "pr", label: "PR", status: "pending" },
    ],
    footer: "Artifacts: .lastlight/",
  };

  it("renders heading, subtitle, meta, checklist and footer in order", () => {
    const out = renderProgress(model);
    const lines = out.split("\n");
    expect(lines[0]).toBe("### 🤖 build for #18");
    expect(out).toContain("**Add retry to fetch**");
    expect(out).toContain("Branch: [`lastlight/18`]");
    expect(out).toContain(`- ${STATUS_EMOJI.done} **Guardrails** — READY`);
    expect(out).toContain(`- ${STATUS_EMOJI.running} **Architect**`);
    expect(out).toContain(`- ${STATUS_EMOJI.pending} **PR**`);
    expect(out.trimEnd().endsWith("Artifacts: .lastlight/")).toBe(true);
  });

  it("omits detail dash when a step has no detail", () => {
    const out = renderProgress(model);
    expect(out).toContain(`**Architect**\n`);
    expect(out).not.toContain("**Architect** —");
  });

  it("renders a minimal model (no subtitle/meta/footer)", () => {
    const out = renderProgress({ title: "t", steps: [{ key: "a", label: "A", status: "pending" }] });
    expect(out).toContain("### 🤖 t");
    expect(out).toContain(`- ${STATUS_EMOJI.pending} **A**`);
  });
});
