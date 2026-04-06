import type { CronJob } from "./scheduler.js";

/** Managed repositories — these get periodic triage and review */
const MANAGED_REPOS = ["cliftonc/drizzle-cube", "cliftonc/drizby"];

/**
 * Get cron jobs based on configuration.
 *
 * When webhooks are enabled (WEBHOOK_SECRET is set), issue triage and PR review
 * happen in real-time via webhook events — no need for polling cron jobs.
 * Only the health report (which has no webhook equivalent) runs on cron.
 */
export function getJobs(opts?: { webhooksEnabled?: boolean }): CronJob[] {
  const jobs: CronJob[] = [];

  // Only poll for issues/PRs if webhooks are NOT handling them
  if (!opts?.webhooksEnabled) {
    jobs.push(
      {
        name: "triage-new-issues",
        schedule: "*/15 * * * *",
        skill: "issue-triage",
        context: { repos: MANAGED_REPOS, mode: "scan" },
      },
      {
        name: "check-prs-awaiting-review",
        schedule: "*/30 * * * *",
        skill: "pr-review",
        context: { repos: MANAGED_REPOS, mode: "scan" },
      }
    );
  }

  // Health report always runs — no webhook equivalent
  jobs.push({
    name: "weekly-health-report",
    schedule: "0 9 * * 1",
    skill: "repo-health",
    context: { repos: MANAGED_REPOS, mode: "report" },
  });

  return jobs;
}
