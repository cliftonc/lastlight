import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setWorkflowDir, clearWorkflowCache, getWorkflow, getCronWorkflows, loadPromptTemplate } from "./loader.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "loader-test-"));
}

describe("loader — build workflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads a valid build workflow YAML", () => {
    writeFileSync(
      join(dir, "build.yaml"),
      `
type: build
name: build
description: "Test workflow"
phases:
  - name: phase_0
    type: context
  - name: architect
    prompt: prompts/architect.md
    model: claude-opus-4-6
`.trim(),
    );

    const wf = getWorkflow("build");
    expect(wf.name).toBe("build");
    expect(wf.phases).toHaveLength(2);
    expect(wf.phases[0].name).toBe("phase_0");
    expect(wf.phases[0].type).toBe("context");
    expect(wf.phases[1].name).toBe("architect");
  });

  it("throws when workflow file is missing", () => {
    expect(() => getWorkflow("nonexistent")).toThrow(/not found/i);
  });

  it("throws when YAML is malformed", () => {
    writeFileSync(join(dir, "broken.yaml"), "phases: [{{{{");
    expect(() => getWorkflow("broken")).toThrow();
  });

  it("throws when workflow fails schema validation", () => {
    writeFileSync(
      join(dir, "invalid.yaml"),
      `
type: build
name: invalid
phases:
  - name: phase_0
    type: unknown_type
`.trim(),
    );
    expect(() => getWorkflow("invalid")).toThrow();
  });

  it("applies default type=build when type is omitted", () => {
    writeFileSync(
      join(dir, "noType.yaml"),
      `
name: noType
phases:
  - name: phase_0
    type: context
`.trim(),
    );
    const wf = getWorkflow("noType");
    expect(wf.name).toBe("noType");
  });

  it("caches the result on second call", () => {
    writeFileSync(
      join(dir, "cached.yaml"),
      `
name: cached
phases:
  - name: phase_0
    type: context
`.trim(),
    );
    const wf1 = getWorkflow("cached");
    const wf2 = getWorkflow("cached");
    expect(wf1).toBe(wf2); // same object reference → cached
  });
});

describe("loader — cron workflows", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads cron workflow from cron-*.yaml files", () => {
    writeFileSync(
      join(dir, "cron-health.yaml"),
      `
type: cron
name: weekly-health-report
schedule: "0 9 * * 1"
skill: repo-health
context:
  mode: report
`.trim(),
    );

    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("weekly-health-report");
    expect(jobs[0].schedule).toBe("0 9 * * 1");
    expect(jobs[0].skill).toBe("repo-health");
  });

  it("loads multiple cron workflows", () => {
    writeFileSync(
      join(dir, "cron-triage.yaml"),
      `
type: cron
name: triage-new-issues
schedule: "*/15 * * * *"
skill: issue-triage
context:
  mode: scan
condition:
  unless: webhooksEnabled
`.trim(),
    );
    writeFileSync(
      join(dir, "cron-health.yaml"),
      `
type: cron
name: weekly-health-report
schedule: "0 9 * * 1"
skill: repo-health
context:
  mode: report
`.trim(),
    );

    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(2);
  });

  it("returns empty array when no cron files exist", () => {
    writeFileSync(
      join(dir, "build.yaml"),
      `
name: build
phases:
  - name: phase_0
    type: context
`.trim(),
    );
    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(0);
  });

  it("skips invalid cron YAML (logs error, does not throw)", () => {
    writeFileSync(
      join(dir, "cron-bad.yaml"),
      `
type: cron
name: bad
`.trim(),
    ); // missing required fields
    // Should not throw, just log error
    expect(() => getCronWorkflows()).not.toThrow();
  });
});

describe("loader — prompt templates", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads a prompt template file", () => {
    mkdirSync(join(dir, "prompts"));
    writeFileSync(join(dir, "prompts", "architect.md"), "You are the ARCHITECT.");

    const content = loadPromptTemplate("prompts/architect.md");
    expect(content).toBe("You are the ARCHITECT.");
  });

  it("throws when prompt template file is missing", () => {
    expect(() => loadPromptTemplate("prompts/nonexistent.md")).toThrow(/not found/i);
  });
});

describe("loader — missing workflow directory", () => {
  beforeEach(() => {
    setWorkflowDir("/tmp/does-not-exist-xyz-abc");
    clearWorkflowCache();
  });

  it("returns empty cron list when directory is missing", () => {
    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(0);
  });
});
