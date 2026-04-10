import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDb } from "./db.js";
import { randomUUID } from "crypto";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workflow_runs CRUD", () => {
  it("creates a workflow run and retrieves it by ID", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#1",
      repo: "repo",
      issueNumber: 1,
      currentPhase: "phase_0",
      status: "running",
      context: { branch: "lastlight/1-test" },
      startedAt: now,
      finishedAt: undefined,
    });

    const run = db.getWorkflowRun(id);
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
    expect(run!.workflowName).toBe("build");
    expect(run!.triggerId).toBe("owner/repo#1");
    expect(run!.repo).toBe("repo");
    expect(run!.issueNumber).toBe(1);
    expect(run!.currentPhase).toBe("phase_0");
    expect(run!.status).toBe("running");
    expect(run!.phaseHistory).toEqual([]);
    expect(run!.context).toEqual({ branch: "lastlight/1-test" });
  });

  it("returns null for a non-existent ID", () => {
    expect(db.getWorkflowRun("no-such-id")).toBeNull();
  });

  it("updates phase and appends to phase_history", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#2",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    const entry = { phase: "guardrails", timestamp: new Date().toISOString(), success: true, summary: "READY" };
    db.updateWorkflowPhase(id, "guardrails", entry);

    const run = db.getWorkflowRun(id);
    expect(run!.currentPhase).toBe("guardrails");
    expect(run!.phaseHistory).toHaveLength(1);
    expect(run!.phaseHistory[0]).toEqual(entry);
  });

  it("appends multiple phase history entries", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#3",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    db.updateWorkflowPhase(id, "guardrails", { phase: "guardrails", timestamp: now, success: true });
    db.updateWorkflowPhase(id, "architect", { phase: "architect", timestamp: now, success: true });
    db.updateWorkflowPhase(id, "executor", { phase: "executor", timestamp: now, success: true });

    const run = db.getWorkflowRun(id);
    expect(run!.currentPhase).toBe("executor");
    expect(run!.phaseHistory).toHaveLength(3);
    expect(run!.phaseHistory.map((e) => e.phase)).toEqual(["guardrails", "architect", "executor"]);
  });

  it("finishes a workflow run with succeeded status", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#4",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    db.finishWorkflowRun(id, "succeeded");
    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).toBeTruthy();
  });

  it("finishes a workflow run with failed status", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#5",
      currentPhase: "architect",
      status: "running",
      startedAt: now,
    });

    db.finishWorkflowRun(id, "failed", "some error");
    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("failed");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("getWorkflowRunByTrigger", () => {
  it("returns the active run for a trigger", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#10",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    const run = db.getWorkflowRunByTrigger("owner/repo#10");
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
  });

  it("ignores failed or succeeded runs", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#11",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });
    db.finishWorkflowRun(id, "failed");

    expect(db.getWorkflowRunByTrigger("owner/repo#11")).toBeNull();
  });

  it("returns null when no run exists for trigger", () => {
    expect(db.getWorkflowRunByTrigger("owner/repo#999")).toBeNull();
  });

  it("returns the most recent active run when multiple exist", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    db.createWorkflowRun({
      id: id1,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "guardrails",
      status: "running",
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    db.createWorkflowRun({
      id: id2,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = db.getWorkflowRunByTrigger("owner/repo#12");
    expect(run!.id).toBe(id2);
  });
});

describe("activeWorkflowRuns", () => {
  it("returns only running and paused runs", () => {
    const now = new Date().toISOString();

    const runningId = randomUUID();
    db.createWorkflowRun({ id: runningId, workflowName: "build", triggerId: "t1", currentPhase: "guardrails", status: "running", startedAt: now });

    const failedId = randomUUID();
    db.createWorkflowRun({ id: failedId, workflowName: "build", triggerId: "t2", currentPhase: "executor", status: "running", startedAt: now });
    db.finishWorkflowRun(failedId, "failed");

    const active = db.activeWorkflowRuns();
    expect(active.map((r) => r.id)).toContain(runningId);
    expect(active.map((r) => r.id)).not.toContain(failedId);
  });
});

describe("recentWorkflowRuns", () => {
  it("respects limit and orders by started_at DESC", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.createWorkflowRun({
        id: randomUUID(),
        workflowName: "build",
        triggerId: `t${i}`,
        currentPhase: "phase_0",
        status: "running",
        startedAt: new Date(now + i * 1000).toISOString(),
      });
    }

    const runs = db.recentWorkflowRuns(3);
    expect(runs).toHaveLength(3);
    // Most recent first
    expect(runs[0]!.startedAt >= runs[1]!.startedAt).toBe(true);
    expect(runs[1]!.startedAt >= runs[2]!.startedAt).toBe(true);
  });
});

describe("cancelWorkflowRun", () => {
  it("sets status to cancelled", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({ id, workflowName: "build", triggerId: "t-cancel", currentPhase: "executor", status: "running", startedAt: now });
    db.cancelWorkflowRun(id);

    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("cancelled");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("context JSON round-trip", () => {
  it("stores and retrieves complex context objects", () => {
    const id = randomUUID();
    const context = { branch: "lastlight/42-my-feature", taskId: "repo-42", models: { architect: "claude-opus-4-6" } };
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#42",
      currentPhase: "phase_0",
      status: "running",
      context,
      startedAt: new Date().toISOString(),
    });

    const run = db.getWorkflowRun(id);
    expect(run!.context).toEqual(context);
  });

  it("handles runs without context", () => {
    const id = randomUUID();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#43",
      currentPhase: "phase_0",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = db.getWorkflowRun(id);
    expect(run!.context).toBeUndefined();
  });
});
