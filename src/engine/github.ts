import { Octokit } from "octokit";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createAppAuth } from "@octokit/auth-app";

/**
 * GitHub client for the harness — uses GitHub App auth.
 * Used by the orchestrator to post comments, not by agent sessions.
 */
export class GitHubClient {
  private octokit: Octokit;

  constructor(config: { appId: string; privateKeyPath: string; installationId: string }) {
    const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");

    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey,
        installationId: config.installationId,
      },
    });
  }

  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
  }

  /**
   * Add an emoji reaction to a specific issue comment. Used as an immediate
   * (silent) acknowledgment that the agent has accepted a request, before
   * any actual work — and any chatty bot comments — start.
   *
   * Reaction `content` values: "+1" | "-1" | "laugh" | "confused" | "heart"
   * | "hooray" | "rocket" | "eyes".
   */
  async reactToComment(
    owner: string,
    repo: string,
    commentId: number,
    content: "rocket" | "+1" | "eyes" | "hooray" = "rocket",
  ): Promise<void> {
    await this.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  }

  async getIssue(owner: string, repo: string, issueNumber: number) {
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data;
  }

  /**
   * Fetch the issue body. Used by the dispatch path so build/explore/pr-fix
   * workflows always see the real issue body, even when triggered from a
   * comment (where the EventEnvelope.body field is the comment, not the
   * issue body).
   */
  async getIssueBody(owner: string, repo: string, issueNumber: number): Promise<string> {
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data.body || "";
  }

  /**
   * List all comments on an issue/PR, oldest first. Used by the dispatch path
   * to inject the full conversation thread into the architect's context — the
   * spec the bot writes during an `explore` run lives here, and the build
   * cycle needs to see it to implement the agreed design.
   */
  async listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<Array<{ user: string; body: string; createdAt: string }>> {
    const data = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      { owner, repo, issue_number: issueNumber, per_page: 100 },
    );
    return data.map((c) => ({
      user: c.user?.login || "unknown",
      body: c.body || "",
      createdAt: c.created_at,
    }));
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data;
  }

  /** Convenience: fetch only the PR's head commit SHA. Used by check-run code. */
  async getPullRequestHeadSha(owner: string, repo: string, pullNumber: number): Promise<string> {
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data.head.sha;
  }

  /**
   * Create a Check Run on a PR's head commit. Returns the new check_run id so
   * the caller can later transition it from `in_progress` → `completed` with
   * a conclusion. Repos that enable "Require status checks to pass" with
   * `name` in their list will gate merges on the eventual conclusion.
   *
   * Requires the GitHub App to have `Checks: Read and write` permission.
   */
  async createCheckRun(
    owner: string,
    repo: string,
    headSha: string,
    name: string,
    options: { detailsUrl?: string; output?: { title: string; summary: string } } = {},
  ): Promise<number> {
    const { data } = await this.octokit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return data.id;
  }

  /**
   * Update an existing Check Run — typically to transition `in_progress` →
   * `completed` with a conclusion. Conclusion values that branch protection
   * treats as passing: `success`, `neutral`, `skipped`. Failing: `failure`,
   * `cancelled`, `timed_out`, `action_required`.
   */
  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    update: {
      status?: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required"
        | "skipped";
      output?: { title: string; summary: string };
    },
  ): Promise<void> {
    await this.octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      ...(update.status ? { status: update.status } : {}),
      ...(update.conclusion ? { conclusion: update.conclusion } : {}),
      ...(update.status === "completed" ? { completed_at: new Date().toISOString() } : {}),
      ...(update.output ? { output: update.output } : {}),
    });
  }

  /**
   * Find the bot's most recent review on this PR's current head commit. Used
   * after a pr-review workflow finishes to derive the check-run conclusion
   * from the review the agent actually posted (APPROVE / REQUEST_CHANGES /
   * COMMENT). Returns null when the bot hasn't reviewed this SHA yet.
   *
   * `botLogin` defaults to `last-light[bot]` so the lookup matches App-auth'd
   * reviews regardless of how the agent identified itself.
   */
  async getLatestBotReview(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
    botLogin = "last-light[bot]",
  ): Promise<{ state: string; body: string | null; submittedAt: string | null } | null> {
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    // Reviews are returned oldest-first; iterate newest-first to pick the most
    // recent one tied to this SHA. `commit_id` on a review is the head sha at
    // the time the review was submitted, which is exactly the discriminator
    // we want — re-pushes invalidate stale reviews here naturally.
    for (let i = reviews.length - 1; i >= 0; i--) {
      const r = reviews[i]!;
      if (r.user?.login === botLogin && r.commit_id === headSha) {
        return { state: r.state, body: r.body ?? null, submittedAt: r.submitted_at ?? null };
      }
    }
    return null;
  }

  /**
   * Get failed check runs for a PR's head SHA.
   * Fetches the actual job logs (not just annotations) to show real errors.
   */
  async getFailedChecks(owner: string, repo: string, ref: string): Promise<string> {
    try {
      const { data } = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        filter: "latest",
      });

      const failed = data.check_runs.filter(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out"
      );

      if (failed.length === 0) return "No failed checks found.";

      const summaries = await Promise.all(failed.map(async (run) => {
        let logExcerpt = "";

        // Try to fetch the actual job log (contains the real errors)
        if (run.details_url) {
          try {
            // Extract the job ID from the check run — the run is linked to a workflow job
            const jobId = run.id;
            const { data: logData } = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: jobId,
            });
            // logData is a string with the full log
            const fullLog = typeof logData === "string" ? logData : String(logData);
            // Extract the last N lines which typically contain the error
            const lines = fullLog.split("\n");
            // Find error lines and surrounding context
            const errorLines: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.match(/error|ERR!|FAIL|failed|Error:|npm ERR/i) && !line.match(/^$/)) {
                // Include some context before and after
                const start = Math.max(0, i - 2);
                const end = Math.min(lines.length, i + 5);
                for (let j = start; j < end; j++) {
                  if (!errorLines.includes(lines[j])) {
                    errorLines.push(lines[j]);
                  }
                }
              }
            }
            if (errorLines.length > 0) {
              logExcerpt = errorLines.slice(0, 50).join("\n");
            } else {
              // No error lines found — show the last 30 lines
              logExcerpt = lines.slice(-30).join("\n");
            }
          } catch {
            // Job logs may not be available — fall back to annotations
          }
        }

        // Fall back to annotations if no job logs
        if (!logExcerpt) {
          try {
            const { data: annotations } = await this.octokit.rest.checks.listAnnotations({
              owner,
              repo,
              check_run_id: run.id,
            });
            if (annotations.length > 0) {
              logExcerpt = annotations
                .filter((a) => a.annotation_level === "failure")
                .slice(0, 10)
                .map((a) => `${a.path}:${a.start_line} — ${a.message}`)
                .join("\n");
            }
          } catch { /* annotations may not be available */ }
        }

        return `### ${run.name}: ${run.conclusion}\n${logExcerpt || "No log details available."}`;
      }));

      return summaries.join("\n\n");
    } catch (err: any) {
      return `Could not fetch check runs: ${err.message}`;
    }
  }
}
