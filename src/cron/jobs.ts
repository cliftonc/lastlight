import type { CronJob } from "./scheduler.js";
import { MANAGED_REPOS } from "../managed-repos.js";
import { getCronWorkflows } from "../workflows/loader.js";

/**
 * Get cron jobs based on configuration.
 *
 * Cron job definitions are loaded from workflows/cron-*.yaml files. Each
 * cron YAML references an agent workflow by name (workflows/<name>.yaml)
 * which is invoked on each tick. When webhooks are enabled
 * (WEBHOOK_SECRET is set), jobs with `condition.unless: webhooksEnabled`
 * are filtered out — those are handled in real-time via webhook events.
 */
export function getJobs(opts?: { webhooksEnabled?: boolean }): CronJob[] {
  const jobs: CronJob[] = [];

  let cronDefs = getCronWorkflows();

  // Apply conditions
  if (opts?.webhooksEnabled) {
    cronDefs = cronDefs.filter((def) => def.condition?.unless !== "webhooksEnabled");
  }

  for (const def of cronDefs) {
    jobs.push({
      name: def.name,
      schedule: def.schedule,
      workflow: def.workflow,
      // Merge managed repos into the context the workflow receives
      context: { repos: MANAGED_REPOS, ...def.context },
    });
  }

  return jobs;
}
