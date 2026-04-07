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
}
