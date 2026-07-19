/**
 * Turn Last Light's bare `owner/repo` + issue/PR number into github.com links.
 *
 * Runs only carry a bare `owner/repo` string and a single `issueNumber` (used
 * for both issues and PRs — there's no separate `prNumber`). Only emit a link
 * when the repo string actually looks like `owner/repo`; some runs store just
 * the bare repo name (the owner then lives in `run.context.owner`), which we
 * can't turn into a URL on its own.
 */

const GITHUB = "https://github.com";

const OWNER_REPO = /^[^/\s]+\/[^/\s]+$/;

/** `owner/repo` → `https://github.com/owner/repo`, else `null`. */
export function repoUrl(repo: string | null | undefined): string | null {
  const full = repo?.trim();
  if (!full || !OWNER_REPO.test(full)) return null;
  return `${GITHUB}/${full}`;
}

/**
 * Resolve a run's qualified `owner/repo` for linking, else `null`.
 *
 * Workflow runs store `repo` as a BARE name (`drizzle-cube-help`) — the owner
 * isn't on that field — so `repoUrl(run.repo)` alone never links a run. The
 * qualified path lives elsewhere: `triggerId` is `owner/repo#N` (present in the
 * list payload) and `context.owner` carries the owner (detail payload only).
 * Prefer whichever already yields a full `owner/repo`.
 */
export function runRepoPath(run: {
  repo?: string | null;
  triggerId?: string | null;
  context?: Record<string, unknown> | null;
}): string | null {
  const bare = run.repo?.trim();
  if (bare && OWNER_REPO.test(bare)) return bare;
  // `triggerId` is built as `owner/repo#N` (issue/PR-scoped) or
  // `owner/repo::workflowName` (repo-scoped) — pull the LEADING `owner/repo`,
  // stopping at the `#` or `:` suffix so `owner/repo::repo-health` doesn't
  // slip through as a bogus repo. Slack/cron trigger ids won't match → no link.
  const fromTrigger = run.triggerId?.match(/^([^/\s#:]+\/[^/\s#:]+)(?:$|[#:])/)?.[1];
  if (fromTrigger) return fromTrigger;
  // Bare repo + owner from the detail payload's context (list rows omit it).
  const owner = typeof run.context?.owner === "string" ? run.context.owner.trim() : "";
  if (bare && owner && !bare.includes("/")) return `${owner}/${bare}`;
  return null;
}

/**
 * `owner/repo` + number → the issue/PR URL, else `null`.
 *
 * GitHub shares one number space between issues and PRs and redirects between
 * `/issues/N` and `/pull/N`, so the path only affects which tab loads first.
 * We pick `pull` for PR-oriented workflows (name contains "pr") and `issues`
 * otherwise — either lands on the right page regardless.
 */
export function issueUrl(
  repo: string | null | undefined,
  issueNumber: number | null | undefined,
  workflowName?: string,
): string | null {
  const base = repoUrl(repo);
  if (!base || !issueNumber) return null;
  const isPr = workflowName ? /(^|[-_])pr([-_]|$)/i.test(workflowName) : false;
  return `${base}/${isPr ? "pull" : "issues"}/${issueNumber}`;
}
