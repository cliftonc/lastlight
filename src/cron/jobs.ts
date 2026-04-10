import type { CronJob } from "./scheduler.js";
import { MANAGED_REPOS } from "../managed-repos.js";
import { getCronWorkflows } from "../workflows/loader.js";

/**
 * Get cron jobs based on configuration.
 *
 * Cron job definitions are loaded from workflows/cron-*.yaml files.
 * When webhooks are enabled (WEBHOOK_SECRET is set), jobs with
 * `condition.unless: webhooksEnabled` are filtered out — those are handled
 * in real-time via webhook events instead.
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
      skill: def.skill,
      // Merge repos from managed repos with context from the YAML
      context: { repos: MANAGED_REPOS, ...def.context },
    });
  }

  return jobs;
}
