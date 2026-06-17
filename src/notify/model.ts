/**
 * Pure helpers for building and mutating a {@link ProgressModel}'s step list.
 * All functions are immutable — they return new arrays/objects and never
 * mutate their inputs, so the notifier can re-render from a fresh snapshot.
 *
 * Ported from the Mastra rebuild's `initProgress` / `setStatus` /
 * `upsertBefore` (`~/work/mac/.../workflows/build.ts`), generalized to derive
 * the initial list from any workflow definition's phases rather than a
 * hardcoded build pipeline.
 */
import type { AgentWorkflowDefinition, PhaseDefinition } from "../workflows/schema.js";
import type { ProgressModel, ProgressStep, StepStatus } from "./types.js";

/** Human label for a phase — falls back to a title-cased name. */
function phaseLabel(phase: PhaseDefinition): string {
  if (phase.label) return phase.label;
  return phase.name
    .split(/[_\-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build the initial checklist from a workflow definition. `context`-type
 * phases are skipped — they're dashboard checkpoints, not work the user cares
 * to watch. Any phase whose name is in `completed` is seeded as `done` (used
 * when re-attaching to an in-flight run after an approval-gate pause/restart).
 */
export function stepsFromPhases(
  definition: AgentWorkflowDefinition,
  completed: ReadonlySet<string> = new Set(),
): ProgressStep[] {
  return definition.phases
    .filter((p) => (p.type ?? "agent") !== "context")
    .map((p) => ({
      key: p.name,
      label: phaseLabel(p),
      status: (completed.has(p.name) ? "done" : "pending") as StepStatus,
    }));
}

export interface ProgressModelInput {
  workflowName: string;
  /** Issue/PR number, when the run is issue-scoped. */
  number?: number;
  issueTitle?: string;
  owner?: string;
  repo?: string;
  branch?: string;
  /** Phases already finished (resume re-seeding) — seeded as `done`. */
  completed?: ReadonlySet<string>;
}

/**
 * Build the full {@link ProgressModel} for a run. Shared by the fresh-dispatch
 * path (`simple.ts`) and the boot-recovery path (`resume.ts`) so the heading,
 * branch link, and step list stay identical regardless of entry point.
 */
export function buildProgressModel(
  definition: AgentWorkflowDefinition,
  input: ProgressModelInput,
): ProgressModel {
  const titleScope = input.number !== undefined ? `#${input.number}` : input.workflowName;
  const meta: string[] = [];
  if (input.owner && input.repo && input.branch) {
    meta.push(
      `Branch: [\`${input.branch}\`](https://github.com/${input.owner}/${input.repo}/tree/${input.branch})`,
    );
  }
  return {
    title: `${input.workflowName} for ${titleScope}`,
    subtitle: input.issueTitle || undefined,
    meta: meta.length > 0 ? meta : undefined,
    steps: stepsFromPhases(definition, input.completed ?? new Set()),
  };
}

/** Return a copy of `steps` with `key`'s status (and optional detail) updated. */
export function setStep(
  steps: ProgressStep[],
  key: string,
  status: StepStatus,
  detail?: string,
): ProgressStep[] {
  let found = false;
  const next = steps.map((s) => {
    if (s.key !== key) return s;
    found = true;
    // Preserve an existing detail when the caller doesn't supply a new one.
    return { ...s, status, detail: detail ?? s.detail };
  });
  // Unknown key → append so a stray transition still shows up rather than
  // silently vanishing.
  if (!found) next.push({ key, label: key, status, detail });
  return next;
}

/**
 * Insert `entry` before the step keyed `beforeKey`. If the key already exists
 * it's updated in place; if `beforeKey` is omitted or not found, `entry` is
 * appended. Used for loop iterations (re-review / fix cycles) that should sit
 * just above the terminal step.
 */
export function upsertBefore(
  steps: ProgressStep[],
  entry: ProgressStep,
  beforeKey?: string,
): ProgressStep[] {
  if (steps.some((s) => s.key === entry.key)) {
    return steps.map((s) => (s.key === entry.key ? { ...s, ...entry } : s));
  }
  const idx = beforeKey ? steps.findIndex((s) => s.key === beforeKey) : -1;
  if (idx < 0) return [...steps, entry];
  return [...steps.slice(0, idx), entry, ...steps.slice(idx)];
}
