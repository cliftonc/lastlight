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

  async getIssue(owner: string, repo: string, issueNumber: number) {
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data;
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data;
  }

  /**
   * Get failed check runs for a PR's head SHA.
   * Returns a summary of failures including name, conclusion, and output.
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
        let log = "";
        // Try to get the log annotations (error messages from CI)
        try {
          const { data: annotations } = await this.octokit.rest.checks.listAnnotations({
            owner,
            repo,
            check_run_id: run.id,
          });
          if (annotations.length > 0) {
            log = annotations
              .slice(0, 20) // Cap at 20 annotations
              .map((a) => `  ${a.path}:${a.start_line} — ${a.annotation_level}: ${a.message}`)
              .join("\n");
          }
        } catch { /* annotations may not be available */ }

        const output = run.output?.summary
          ? `\n  Summary: ${run.output.summary.slice(0, 500)}`
          : "";

        return `- **${run.name}**: ${run.conclusion}${output}${log ? `\n  Annotations:\n${log}` : ""}`;
      }));

      return summaries.join("\n\n");
    } catch (err: any) {
      return `Could not fetch check runs: ${err.message}`;
    }
  }
}
