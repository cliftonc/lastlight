import { describe, it, expect, vi } from "vitest";
import { ProgressNotifier } from "./notifier.js";
import type { NotifierTransport, ProgressModel } from "./types.js";

function fakeTransport() {
  const published: string[] = [];
  const notes: string[] = [];
  const t: NotifierTransport = {
    publish: vi.fn(async (md: string) => { published.push(md); }),
    note: vi.fn(async (md: string) => { notes.push(md); }),
  };
  return { t, published, notes };
}

const model: ProgressModel = {
  title: "build for #1",
  steps: [
    { key: "a", label: "A", status: "pending" },
    { key: "b", label: "B", status: "pending" },
  ],
};

describe("ProgressNotifier", () => {
  it("publishes the initial model on start and re-publishes on each mutation", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.step("a", "running", "working");
    await n.step("a", "done");
    expect(published).toHaveLength(3);
    expect(published[0]).toContain("**A**");
    expect(published[1]).toContain("**A** — working");
    expect(published[2]).toMatch(/✅ \*\*A\*\*/);
  });

  it("insertStep adds a dynamic row before the named key", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.insertStep({ key: "x", label: "Fix (cycle 1)", status: "running" }, "b");
    const last = published[published.length - 1];
    expect(last.indexOf("Fix (cycle 1)")).toBeGreaterThan(last.indexOf("**A**"));
    expect(last.indexOf("Fix (cycle 1)")).toBeLessThan(last.indexOf("**B**"));
  });

  it("note posts a standalone message to every transport and skips empties", async () => {
    const { t, notes } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.start(model);
    await n.note("done!");
    await n.note("   ");
    expect(notes).toEqual(["done!"]);
  });

  it("fans out to multiple transports and survives one failing", async () => {
    const ok = fakeTransport();
    const bad: NotifierTransport = {
      publish: vi.fn(async () => { throw new Error("boom"); }),
      note: vi.fn(async () => {}),
    };
    const n = new ProgressNotifier([bad, ok.t]);
    await expect(n.start(model)).resolves.toBeUndefined();
    expect(ok.published).toHaveLength(1); // healthy transport still got it
  });

  it("no-ops cleanly with zero transports", async () => {
    const n = new ProgressNotifier([]);
    await expect(n.start(model)).resolves.toBeUndefined();
    await expect(n.step("a", "done")).resolves.toBeUndefined();
    await expect(n.note("x")).resolves.toBeUndefined();
  });

  it("ignores step/insert before start (no model yet)", async () => {
    const { t, published } = fakeTransport();
    const n = new ProgressNotifier([t]);
    await n.step("a", "done");
    expect(published).toHaveLength(0);
  });
});
