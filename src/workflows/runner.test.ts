import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BuildWorkflowDefinition } from "./schema.js";
import type { TemplateContext } from "./templates.js";
import type { RunnerCallbacks, ApprovalGateConfig } from "./runner.js";
import type { StateDb } from "../state/db.js";

// Mock the executor so we don't make real agent calls
vi.mock("../engine/executor.js", () => ({
  executeAgent: vi.fn(),
}));

// Mock the docker module
vi.mock("../admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

// Mock the loader so templates come from strings, not files
vi.mock("./loader.js", () => ({
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
}));

import { executeAgent } from "../engine/executor.js";
import { runWorkflow } from "./runner.js";

const mockExecuteAgent = vi.mocked(executeAgent);

const BASE_CTX: TemplateContext = {
  owner: "acme",
  repo: "widget",
  issueNumber: 42,
  issueTitle: "Add Rate Limiter",
  issueBody: "We need a rate limiter",
  issueLabels: [],
  commentBody: "",
  sender: "alice",
  branch: "lastlight/42-add-rate-limiter",
  taskId: "widget-42",
  issueDir: ".lastlight/issue-42",
  bootstrapLabel: "lastlight:bootstrap",
};

function makeSuccessResult(output = "success output") {
  return {
    success: true,
    output,
    error: undefined,
    turns: 5,
    durationMs: 1000,
  };
}

function makeFailResult(error = "something went wrong") {
  return {
    success: false,
    output: "",
    error,
    turns: 2,
    durationMs: 500,
  };
}

const SIMPLE_WORKFLOW: BuildWorkflowDefinition = {
  type: "build",
  name: "simple",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "architect", type: "agent", prompt: "prompts/architect.md" },
    { name: "executor", type: "agent", prompt: "prompts/executor.md" },
  ],
};

const WORKFLOW_WITH_GUARDRAILS: BuildWorkflowDefinition = {
  type: "build",
  name: "guarded",
  phases: [
    { name: "phase_0", type: "context" },
    {
      name: "guardrails",
      type: "agent",
      prompt: "prompts/guardrails.md",
      on_output: {
        contains_BLOCKED: {
          action: "fail",
          message: "Guardrails check: BLOCKED",
          unless_label: "lastlight:bootstrap",
        },
        contains_READY: { action: "continue" },
      },
    },
    { name: "architect", type: "agent", prompt: "prompts/architect.md" },
  ],
};

const WORKFLOW_WITH_REVIEWER_LOOP: BuildWorkflowDefinition = {
  type: "build",
  name: "full",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "executor", type: "agent", prompt: "prompts/executor.md" },
    {
      name: "reviewer",
      type: "agent",
      prompt: "prompts/reviewer.md",
      loop: {
        max_cycles: 2,
        on_request_changes: {
          fix_prompt: "prompts/fix.md",
          re_review_prompt: "prompts/re-reviewer.md",
        },
      },
    },
    { name: "pr", type: "agent", prompt: "prompts/pr.md", on_success: { set_phase: "complete" } },
  ],
};

describe("runWorkflow — basic phase execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes context phase without calling executeAgent", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const result = await runWorkflow(
      {
        type: "build",
        name: "ctx-only",
        phases: [{ name: "phase_0", type: "context" }],
      },
      BASE_CTX,
      {} as never,
      {},
    );

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phase).toBe("phase_0");
    expect(result.phases[0].success).toBe(true);
  });

  it("executes agent phases in order", async () => {
    const calls: string[] = [];
    mockExecuteAgent.mockImplementation(async (prompt: string) => {
      calls.push(prompt);
      return makeSuccessResult();
    });

    await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});

    // Two agent phases: architect and executor
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    // The prompts contain the template path (mocked as TEMPLATE:path)
    expect(calls[0]).toContain("prompts/architect.md");
    expect(calls[1]).toContain("prompts/executor.md");
  });

  it("returns success=true when all phases pass", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const result = await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
  });

  it("returns success=false and stops on phase failure", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("architect done"))
      .mockResolvedValueOnce(makeFailResult("executor exploded"));

    const result = await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});
    expect(result.success).toBe(false);
    // Only two phases executed (phase_0 + architect + executor)
    // phase_0 = context, architect = success, executor = fail → stops
    const names = result.phases.map((p) => p.phase);
    expect(names).toContain("architect");
    expect(names).toContain("executor");
    expect(names).not.toContain("pr");
  });
});

describe("runWorkflow — guardrails on_output rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails workflow when guardrails output contains BLOCKED", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("BLOCKED — no test framework"));

    const comments: string[] = [];
    const result = await runWorkflow(
      WORKFLOW_WITH_GUARDRAILS,
      BASE_CTX,
      {} as never,
      { postComment: async (msg) => { comments.push(msg); } },
    );

    expect(result.success).toBe(false);
    expect(comments.some((c) => c.includes("BLOCKED"))).toBe(true);
    // architect should not have run
    expect(result.phases.map((p) => p.phase)).not.toContain("architect");
  });

  it("bypasses BLOCKED for bootstrap tasks (by label)", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("BLOCKED — no test framework"));
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("READY"));

    const ctx = { ...BASE_CTX, issueLabels: ["lastlight:bootstrap"] };

    // First call = guardrails returns BLOCKED, second = architect succeeds
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("BLOCKED"))
      .mockResolvedValueOnce(makeSuccessResult("architect plan"));

    const result = await runWorkflow(WORKFLOW_WITH_GUARDRAILS, ctx, {} as never, {});
    // Even though guardrails returned BLOCKED, we bypass it because of the label
    expect(result.phases.map((p) => p.phase)).toContain("architect");
  });

  it("bypasses BLOCKED for bootstrap tasks (by title prefix)", async () => {
    const ctx = { ...BASE_CTX, issueTitle: "guardrails: add test framework" };
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("BLOCKED"))
      .mockResolvedValueOnce(makeSuccessResult("architect plan"));

    const result = await runWorkflow(WORKFLOW_WITH_GUARDRAILS, ctx, {} as never, {});
    expect(result.phases.map((p) => p.phase)).toContain("architect");
  });

  it("continues normally when guardrails returns READY", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("READY — all guardrails pass"))
      .mockResolvedValueOnce(makeSuccessResult("architect plan"));

    const result = await runWorkflow(WORKFLOW_WITH_GUARDRAILS, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    expect(result.phases.map((p) => p.phase)).toContain("architect");
  });
});

describe("runWorkflow — reviewer loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves on first review — no fix loop", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done")) // executor
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED\nLooks great!")) // reviewer
      .mockResolvedValueOnce(makeSuccessResult("PR #7 created")); // pr

    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    // executor + reviewer + pr = 3 agent calls
    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
    expect(result.prNumber).toBe(7);
  });

  it("runs one fix cycle on REQUEST_CHANGES then APPROVED", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done")) // executor
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES\nFix the bug")) // reviewer cycle 1
      .mockResolvedValueOnce(makeSuccessResult("fixed")) // fix_loop_1
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED\nAll fixed")) // re-review
      .mockResolvedValueOnce(makeSuccessResult("PR #8 created")); // pr

    const phases: string[] = [];
    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {
      onPhaseStart: async (p) => { phases.push(p); },
    });

    expect(result.success).toBe(true);
    expect(phases).toContain("fix_loop_1");
    expect(result.prNumber).toBe(8);
  });

  it("stops after max_cycles when reviewer keeps requesting changes", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done")) // executor
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES")) // reviewer cycle 1
      .mockResolvedValueOnce(makeSuccessResult("fixed 1")) // fix_loop_1
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES")) // re-review cycle 2
      .mockResolvedValueOnce(makeSuccessResult("fixed 2")) // fix_loop_2
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES")) // re-review cycle 3 (max hit)
      .mockResolvedValueOnce(makeSuccessResult("PR #9 created")); // pr

    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {});
    // Should proceed to PR after max cycles
    expect(result.prNumber).toBe(9);
  });

  it("uses fallback verdict detection when VERDICT: marker is missing", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done"))
      .mockResolvedValueOnce(makeSuccessResult("APPROVED — code looks fine")) // no marker
      .mockResolvedValueOnce(makeSuccessResult("PR #10 created"));

    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(10);
  });
});

const WORKFLOW_WITH_APPROVAL_GATE: BuildWorkflowDefinition = {
  type: "build",
  name: "gated",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "architect", type: "agent", prompt: "prompts/architect.md", approval_gate: "post_architect" },
    { name: "executor", type: "agent", prompt: "prompts/executor.md" },
    { name: "pr", type: "agent", prompt: "prompts/pr.md", on_success: { set_phase: "complete" } },
  ],
};

/**
 * Minimal StateDb mock providing the methods used by runWorkflow.
 * currentPhase controls what getWorkflowRun returns (simulating DB state after
 * the orchestrator updates it prior to calling runWorkflow).
 */
function makeMockDb(currentPhase = "phase_0"): StateDb {
  let phase = currentPhase;
  return {
    shouldRunPhase: vi.fn(() => "run"),
    recordStart: vi.fn(),
    recordFinish: vi.fn(),
    markStaleAsFailed: vi.fn(),
    markLatestAsFailed: vi.fn(),
    updateWorkflowPhase: vi.fn((_id: string, newPhase: string) => { phase = newPhase; }),
    pauseWorkflowRun: vi.fn(),
    resumeWorkflowRun: vi.fn(),
    finishWorkflowRun: vi.fn(),
    createApproval: vi.fn(),
    getWorkflowRun: vi.fn(() => ({ currentPhase: phase, status: "running" })),
    getPendingApprovalForWorkflow: vi.fn(() => null),
  } as unknown as StateDb;
}

describe("runWorkflow — approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses at post_architect gate and does not run executor", async () => {
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("architect plan done"));

    const db = makeMockDb("phase_0");
    const approvalConfig: ApprovalGateConfig = { postArchitect: true, postReviewer: false };

    const result = await runWorkflow(
      WORKFLOW_WITH_APPROVAL_GATE,
      BASE_CTX,
      {} as never,
      {},
      db,
      undefined,
      approvalConfig,
      "wf-gate-1",
    );

    expect(result.paused).toBe(true);
    expect(result.success).toBe(true);
    // Only architect ran — executor and pr were not reached
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(result.phases.map((p) => p.phase)).not.toContain("executor");
  });

  it("resumes from executor after post_architect gate approval (currentPhase=architect in DB)", async () => {
    // Simulate what the orchestrator does after approval: update currentPhase to "architect"
    // so the runner computes resumeFrom = "executor"
    const db = makeMockDb("architect");
    const approvalConfig: ApprovalGateConfig = { postArchitect: true, postReviewer: false };

    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done"))
      .mockResolvedValueOnce(makeSuccessResult("PR #5 created"));

    const result = await runWorkflow(
      WORKFLOW_WITH_APPROVAL_GATE,
      BASE_CTX,
      {} as never,
      {},
      db,
      undefined,
      approvalConfig,
      "wf-gate-1",
    );

    // Not paused — gate phase (architect) was skipped, executor and pr ran
    expect(result.paused).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(5);
    // Only executor + pr ran (architect skipped by shouldRun check)
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it("resumes from specified startFrom phase (no-DB path)", async () => {
    // Simulate no-DB resume: orchestrator parsed current_phase: architect from agent output
    // and passes startFrom="executor" to skip re-running architect
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("executor done"));

    const result = await runWorkflow(
      SIMPLE_WORKFLOW, // phases: phase_0, architect, executor
      BASE_CTX,
      {} as never,
      {},
      undefined, // no DB
      undefined,
      undefined,
      undefined,
      "executor", // startFrom — skip architect
    );

    expect(result.success).toBe(true);
    // Only executor ran — architect was skipped by startFrom
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    const phaseNames = result.phases.map((p) => p.phase);
    expect(phaseNames).toContain("executor");
    expect(phaseNames).not.toContain("architect");
  });
});

describe("runWorkflow — callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onPhaseStart and onPhaseEnd for each phase", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const started: string[] = [];
    const ended: string[] = [];
    const callbacks: RunnerCallbacks = {
      onPhaseStart: async (p) => { started.push(p); },
      onPhaseEnd: async (p) => { ended.push(p); },
    };

    await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, callbacks);

    expect(started).toContain("phase_0");
    expect(started).toContain("architect");
    expect(started).toContain("executor");
    expect(ended).toContain("architect");
    expect(ended).toContain("executor");
  });

  it("calls postComment on phase failures", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult())
      .mockResolvedValueOnce(makeFailResult("connection timeout"));

    const comments: string[] = [];
    await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(comments.some((c) => c.includes("failed"))).toBe(true);
  });
});
