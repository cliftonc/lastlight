// Thin wrapper around Octokit that refreshes the token automatically.

import { Octokit } from "@octokit/rest";

export class GitHubClient {
  constructor(auth) {
    this.auth = auth;
    this._octokit = null;
    this._tokenUsed = null;
  }

  async octokit() {
    const token = await this.auth.getToken();
    if (token !== this._tokenUsed) {
      this._octokit = new Octokit({ auth: token });
      this._tokenUsed = token;
    }
    return this._octokit;
  }

  // ── Repositories ──────────────────────────────────────────────────

  async getFileContents(owner, repo, path, branch) {
    const ok = await this.octokit();
    const params = { owner, repo, path };
    if (branch) params.ref = branch;
    const { data } = await ok.repos.getContent(params);
    if (data.content) {
      data.decoded_content = Buffer.from(data.content, "base64").toString("utf8");
    }
    return data;
  }

  async createOrUpdateFile(owner, repo, path, content, message, branch, sha) {
    const ok = await this.octokit();
    const params = {
      owner, repo, path, message,
      content: Buffer.from(content).toString("base64"),
    };
    if (branch) params.branch = branch;
    if (sha) params.sha = sha;
    const { data } = await ok.repos.createOrUpdateFileContents(params);
    return data;
  }

  async pushFiles(owner, repo, branch, files, message) {
    const ok = await this.octokit();

    // Get the ref
    let ref;
    try {
      const { data } = await ok.git.getRef({ owner, repo, ref: `heads/${branch}` });
      ref = data;
    } catch (e) {
      // Branch doesn't exist — create from default branch
      const { data: repoData } = await ok.repos.get({ owner, repo });
      const { data: defaultRef } = await ok.git.getRef({
        owner, repo, ref: `heads/${repoData.default_branch}`,
      });
      const { data: newRef } = await ok.git.createRef({
        owner, repo,
        ref: `refs/heads/${branch}`,
        sha: defaultRef.object.sha,
      });
      ref = newRef;
    }

    // Create blobs
    const blobs = await Promise.all(
      files.map(async (f) => {
        const { data } = await ok.git.createBlob({
          owner, repo, content: f.content, encoding: "utf-8",
        });
        return { path: f.path, sha: data.sha, mode: "100644", type: "blob" };
      })
    );

    // Create tree
    const { data: tree } = await ok.git.createTree({
      owner, repo, base_tree: ref.object.sha, tree: blobs,
    });

    // Create commit
    const { data: commit } = await ok.git.createCommit({
      owner, repo, message, tree: tree.sha, parents: [ref.object.sha],
    });

    // Update ref
    const { data: updated } = await ok.git.updateRef({
      owner, repo, ref: `heads/${branch}`, sha: commit.sha,
    });

    return { commit: commit.sha, branch, ref: updated };
  }

  async searchRepositories(query, page = 1, perPage = 30) {
    const ok = await this.octokit();
    const { data } = await ok.search.repos({ q: query, page, per_page: perPage });
    return data;
  }

  async getRepository(owner, repo) {
    const ok = await this.octokit();
    const { data } = await ok.repos.get({ owner, repo });
    return data;
  }

  async listBranches(owner, repo, page = 1, perPage = 30) {
    const ok = await this.octokit();
    const { data } = await ok.repos.listBranches({ owner, repo, page, per_page: perPage });
    return data;
  }

  // ── Issues ────────────────────────────────────────────────────────

  async listIssues(owner, repo, opts = {}) {
    const ok = await this.octokit();
    const { data } = await ok.issues.listForRepo({
      owner, repo, state: "open", per_page: 30, ...opts,
    });
    return data;
  }

  async getIssue(owner, repo, issue_number) {
    const ok = await this.octokit();
    const { data } = await ok.issues.get({ owner, repo, issue_number });
    return data;
  }

  async createIssue(owner, repo, title, body, opts = {}) {
    const ok = await this.octokit();
    const { data } = await ok.issues.create({ owner, repo, title, body, ...opts });
    return data;
  }

  async updateIssue(owner, repo, issue_number, updates) {
    const ok = await this.octokit();
    const { data } = await ok.issues.update({ owner, repo, issue_number, ...updates });
    return data;
  }

  async addIssueComment(owner, repo, issue_number, body) {
    const ok = await this.octokit();
    const { data } = await ok.issues.createComment({ owner, repo, issue_number, body });
    return data;
  }

  async listIssueComments(owner, repo, issue_number, opts = {}) {
    const ok = await this.octokit();
    const { data } = await ok.issues.listComments({
      owner, repo, issue_number, per_page: 30, ...opts,
    });
    return data;
  }

  async addLabels(owner, repo, issue_number, labels) {
    const ok = await this.octokit();
    const { data } = await ok.issues.addLabels({ owner, repo, issue_number, labels });
    return data;
  }

  async removeLabel(owner, repo, issue_number, name) {
    const ok = await this.octokit();
    const { data } = await ok.issues.removeLabel({ owner, repo, issue_number, name });
    return data;
  }

  // ── Pull Requests ─────────────────────────────────────────────────

  async listPullRequests(owner, repo, opts = {}) {
    const ok = await this.octokit();
    const { data } = await ok.pulls.list({
      owner, repo, state: "open", per_page: 30, ...opts,
    });
    return data;
  }

  async getPullRequest(owner, repo, pull_number) {
    const ok = await this.octokit();
    const { data } = await ok.pulls.get({ owner, repo, pull_number });
    return data;
  }

  async createPullRequest(owner, repo, title, body, head, base) {
    const ok = await this.octokit();
    const { data } = await ok.pulls.create({ owner, repo, title, body, head, base });
    return data;
  }

  async listPullRequestFiles(owner, repo, pull_number) {
    const ok = await this.octokit();
    const { data } = await ok.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
    return data;
  }

  async createPullRequestReview(owner, repo, pull_number, body, event, comments = []) {
    const ok = await this.octokit();
    const params = { owner, repo, pull_number, body, event };
    if (comments.length) params.comments = comments;
    const { data } = await ok.pulls.createReview(params);
    return data;
  }

  async getPullRequestDiff(owner, repo, pull_number) {
    const ok = await this.octokit();
    const { data } = await ok.pulls.get({
      owner, repo, pull_number,
      mediaType: { format: "diff" },
    });
    return data;
  }

  async mergePullRequest(owner, repo, pull_number, opts = {}) {
    const ok = await this.octokit();
    const { data } = await ok.pulls.merge({ owner, repo, pull_number, ...opts });
    return data;
  }

  // ── Commits & Branches ────────────────────────────────────────────

  async listCommits(owner, repo, opts = {}) {
    const ok = await this.octokit();
    const { data } = await ok.repos.listCommits({
      owner, repo, per_page: 30, ...opts,
    });
    return data;
  }

  async createBranch(owner, repo, branch, fromBranch) {
    const ok = await this.octokit();
    const { data: ref } = await ok.git.getRef({
      owner, repo, ref: `heads/${fromBranch}`,
    });
    const { data } = await ok.git.createRef({
      owner, repo,
      ref: `refs/heads/${branch}`,
      sha: ref.object.sha,
    });
    return data;
  }

  // ── Search ────────────────────────────────────────────────────────

  async searchIssues(query, page = 1, perPage = 30) {
    const ok = await this.octokit();
    const { data } = await ok.search.issuesAndPullRequests({
      q: query, page, per_page: perPage,
    });
    return data;
  }

  async searchCode(query, page = 1, perPage = 30) {
    const ok = await this.octokit();
    const { data } = await ok.search.code({ q: query, page, per_page: perPage });
    return data;
  }

  // ── Labels ────────────────────────────────────────────────────────

  async listLabels(owner, repo) {
    const ok = await this.octokit();
    const { data } = await ok.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
    return data;
  }

  async createLabel(owner, repo, name, color, description) {
    const ok = await this.octokit();
    const { data } = await ok.issues.createLabel({ owner, repo, name, color, description });
    return data;
  }
}
