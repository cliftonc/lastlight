/**
 * Derive how each workflow can be triggered, for the admin dashboard.
 *
 * There are three sources of truth:
 *   1. Cron YAMLs (`workflows/cron-*.yaml`) — deterministic; we scan and
 *      report every cron that targets a given workflow.
 *   2. The router (`src/engine/router.ts`) — code-driven mapping from
 *      `EventEnvelope` kinds to workflow names. Mirrored here as a static
 *      table because the router itself is too tied to runtime state to
 *      query directly. Keep this list in sync when router.ts changes.
 *   3. Manual / slash-command invocation (CLI, Slack `/build` etc.).
 *
 * The mirrored table is small and changes rarely — keeping it here, beside
 * the loader, is cheaper than introspecting the router.
 */
import { getCronWorkflows } from "./loader.js";

export type TriggerInfo =
  | { kind: "cron"; name: string; schedule: string }
  | { kind: "github"; event: string; description: string }
  | { kind: "slack"; command: string; description: string }
  | { kind: "mention"; description: string }
  | { kind: "internal"; description: string };

/**
 * Static map of workflow name → trigger sources rooted in the router.
 * Updated alongside `src/engine/router.ts`.
 */
const STATIC_TRIGGERS: Record<string, TriggerInfo[]> = {
  "issue-triage": [
    { kind: "github", event: "issue.opened", description: "An issue is opened" },
    { kind: "github", event: "issue.reopened", description: "An issue is reopened" },
    { kind: "slack", command: "triage", description: "Slack: `triage <repo>`" },
  ],
  "pr-review": [
    { kind: "github", event: "pr.opened", description: "A PR is opened" },
    { kind: "github", event: "pr.synchronize", description: "A PR is updated" },
    { kind: "github", event: "pr.reopened", description: "A PR is reopened" },
    { kind: "slack", command: "review", description: "Slack: `review <repo>`" },
  ],
  "pr-fix": [
    { kind: "mention", description: "`@last-light build …` on a PR comment (maintainers only)" },
  ],
  "pr-comment": [
    { kind: "mention", description: "`@last-light <message>` on a PR comment / review" },
  ],
  build: [
    { kind: "mention", description: "`@last-light build …` on an issue comment (maintainers only)" },
    { kind: "slack", command: "build", description: "Slack: `build <repo>#<n>`" },
  ],
  "issue-comment": [
    { kind: "mention", description: "`@last-light <message>` on an issue comment" },
  ],
  explore: [
    { kind: "mention", description: "`@last-light explore …` on an issue comment" },
    { kind: "slack", command: "explore", description: "Slack: `explore <repo>#<n>`" },
  ],
  "security-review": [
    { kind: "slack", command: "security", description: "Slack: `security <repo>`" },
  ],
  "security-feedback": [
    { kind: "internal", description: "Chained from `security-review` when issues are found" },
  ],
  "repo-health": [
    // Cron-only by default; cron rows are added dynamically below.
  ],
};

/**
 * Return the full trigger list for one workflow — static GitHub/Slack/mention
 * triggers merged with any cron schedules pointing at it.
 */
export function getWorkflowTriggers(workflowName: string): TriggerInfo[] {
  const cronTriggers: TriggerInfo[] = getCronWorkflows()
    .filter((c) => c.workflow === workflowName)
    .map((c) => ({ kind: "cron" as const, name: c.name, schedule: c.schedule }));
  const staticTriggers = STATIC_TRIGGERS[workflowName] ?? [];
  return [...cronTriggers, ...staticTriggers];
}

/**
 * Compact summary used by the workflow list — just the kinds, deduped, in
 * a stable order. The dashboard renders these as small badges.
 */
export function getWorkflowTriggerKinds(workflowName: string): TriggerInfo["kind"][] {
  const triggers = getWorkflowTriggers(workflowName);
  const seen = new Set<TriggerInfo["kind"]>();
  for (const t of triggers) seen.add(t.kind);
  // Stable display order (most "automatic" first)
  const order: TriggerInfo["kind"][] = ["cron", "github", "mention", "slack", "internal"];
  return order.filter((k) => seen.has(k));
}
