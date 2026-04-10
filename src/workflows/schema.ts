import { z } from "zod";

// ── Output rules ──────────────────────────────────────────────────────

const OutputRuleSchema = z.object({
  action: z.enum(["fail", "continue", "pause"]),
  message: z.string().optional(),
  /** Skip the action if the request has this label */
  unless_label: z.string().optional(),
});

const PhaseOnOutputSchema = z.object({
  contains_BLOCKED: OutputRuleSchema.optional(),
  contains_READY: OutputRuleSchema.optional(),
});

// ── Loop configuration ────────────────────────────────────────────────

const PhaseLoopSchema = z.object({
  max_cycles: z.number().int().positive(),
  on_request_changes: z.object({
    fix_prompt: z.string(),
    fix_model: z.string().optional(),
    re_review_prompt: z.string(),
  }),
  /** Gate to pause at before running the fix (optional) */
  approval_gate: z.string().optional(),
});

// ── Phase definition ──────────────────────────────────────────────────

const PhaseDefinitionSchema = z.object({
  name: z.string(),
  /** context: no agent execution (just metadata); agent: run an agent session */
  type: z.enum(["context", "agent"]).default("agent"),
  /** Path to the prompt template file (relative to workflowDir) */
  prompt: z.string().optional(),
  /** Model override — can reference template vars like {{models.architect}} */
  model: z.string().optional(),
  /** Named approval gate to pause at after this phase */
  approval_gate: z.string().optional(),
  /** Loop configuration for reviewer-style looping phases */
  loop: PhaseLoopSchema.optional(),
  /** Rules applied to agent output */
  on_output: PhaseOnOutputSchema.optional(),
  /** Actions taken on successful completion */
  on_success: z
    .object({
      set_phase: z.string().optional(),
    })
    .optional(),
});

export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;
export type PhaseLoop = z.infer<typeof PhaseLoopSchema>;
export type OutputRule = z.infer<typeof OutputRuleSchema>;

// ── Build workflow ────────────────────────────────────────────────────

export const BuildWorkflowSchema = z.object({
  type: z.literal("build").default("build"),
  name: z.string(),
  description: z.string().optional(),
  trigger: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  phases: z.array(PhaseDefinitionSchema),
});

export type BuildWorkflowDefinition = z.infer<typeof BuildWorkflowSchema>;

// ── Cron workflow ─────────────────────────────────────────────────────

export const CronWorkflowSchema = z.object({
  type: z.literal("cron"),
  name: z.string(),
  schedule: z.string(),
  skill: z.string(),
  context: z.record(z.string(), z.unknown()),
  condition: z
    .object({
      unless: z.string().optional(),
    })
    .optional(),
});

export type CronWorkflowDefinition = z.infer<typeof CronWorkflowSchema>;

// ── Union ─────────────────────────────────────────────────────────────

export const WorkflowSchema = z.discriminatedUnion("type", [
  BuildWorkflowSchema,
  CronWorkflowSchema,
]);

export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
