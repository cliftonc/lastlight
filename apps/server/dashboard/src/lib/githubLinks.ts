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
