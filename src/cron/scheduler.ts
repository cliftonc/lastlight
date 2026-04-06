import { Cron } from "croner";
import type { StateDb } from "../state/db.js";

export interface CronJob {
  name: string;
  schedule: string;
  skill: string;
  context: Record<string, unknown>;
  /** Maximum consecutive failures before alerting */
  maxFailures?: number;
}

export type SkillRunner = (skill: string, context: Record<string, unknown>) => Promise<void>;

/**
 * Cron scheduler with overlap protection and failure tracking.
 * Each job runs a skill via the agent executor, tracked in SQLite.
 */
export class CronScheduler {
  private jobs: Map<string, Cron> = new Map();
  private running: Set<string> = new Set();
  private db: StateDb;
  private runner: SkillRunner;

  constructor(db: StateDb, runner: SkillRunner) {
    this.db = db;
    this.runner = runner;
  }

  register(job: CronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }

    const cronJob = new Cron(job.schedule, async () => {
      // Overlap protection — skip if still running
      if (this.running.has(job.name)) {
        console.log(`[cron] Skipping ${job.name} — still running from previous tick`);
        return;
      }

      this.running.add(job.name);
      console.log(`[cron] Running: ${job.name}`);

      try {
        await this.runner(job.skill, job.context);
      } catch (err: any) {
        console.error(`[cron] ${job.name} failed:`, err.message);

        // Check consecutive failures
        const failures = this.db.consecutiveFailures(job.skill);
        const max = job.maxFailures || 3;
        if (failures >= max) {
          console.error(`[cron] ALERT: ${job.name} has failed ${failures} times consecutively`);
          // TODO: send alert (Slack webhook, email, etc.)
        }
      } finally {
        this.running.delete(job.name);
      }
    });

    this.jobs.set(job.name, cronJob);
    console.log(`[cron] Registered: ${job.name} (${job.schedule})`);
  }

  /** Stop all cron jobs */
  stopAll(): void {
    for (const [name, job] of this.jobs) {
      job.stop();
      console.log(`[cron] Stopped: ${name}`);
    }
    this.jobs.clear();
  }
}
