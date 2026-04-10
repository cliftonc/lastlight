/**
 * Authoritative list of repositories Last Light is allowed to operate on.
 *
 * - Webhooks for repos NOT in this list are filtered at the connector level.
 * - Slack/CLI commands targeting unmanaged repos are rejected with a clear error.
 * - Cron jobs (triage scans, weekly health) iterate over this list.
 *
 * To add a new repo: append to MANAGED_REPOS, ensure the GitHub App is installed
 * on it, and redeploy.
 */
export const MANAGED_REPOS = [
  "cliftonc/drizzle-cube",
  "cliftonc/drizby",
  "cliftonc/lastlight",
];

/** Returns true if the given full repo name (owner/repo) is managed. */
export function isManagedRepo(repo: string | undefined | null): boolean {
  if (!repo) return false;
  return MANAGED_REPOS.includes(repo);
}
