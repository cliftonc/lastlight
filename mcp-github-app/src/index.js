#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GitHubAppAuth } from "./auth.js";
import { GitHubClient } from "./github.js";

// ── Config from environment ─────────────────────────────────────────

const appId = process.env.GITHUB_APP_ID;
const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

if (!appId || !privateKeyPath || !installationId) {
  console.error(
    "Required env vars: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID"
  );
  process.exit(1);
}

const auth = new GitHubAppAuth({ appId, privateKeyPath, installationId });
const gh = new GitHubClient(auth);

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "github-app",
  version: "1.0.0",
});

// Helper to run a tool handler and return JSON result
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn) {
  try {
    const result = await fn();
    return jsonResult(result);
  } catch (e) {
    return jsonResult({ error: e.message });
  }
}

// ── Git Auth Tool ───────────────────────────────────────────────────

server.tool(
  "setup_git_auth",
  "Refresh the GitHub App token and write it to the credential file. The token file and .gitconfig-bot are automatically synced into the terminal sandbox by Hermes before each command (via terminal.credential_files). Call this ONCE at the start of a task, and again if git auth fails (token expired). After calling, run the single configure_git command in the terminal.",
  { owner: z.string().describe("Repository owner"), repo: z.string().describe("Repository name") },
  async ({ owner, repo }) => {
    try {
      const token = await auth.getToken();
      const fs = await import("fs");
      const path = await import("path");

      // Write token to HERMES_HOME/.gh-token — Hermes syncs credential_files
      // from HERMES_HOME into the sandbox before each command execution
      // (Modal, Docker, SSH, Daytona all support this).
      const hermesHome = process.env.HERMES_HOME || (process.env.HOME + "/.hermes");
      const tokenPath = path.join(hermesHome, ".gh-token");
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });

      return jsonResult({
        expires_at: auth.expiresAt?.toISOString(),
        token_file: tokenPath,
        configure_git: `git config --global include.path /root/.hermes/.gitconfig-bot`,
        configure_gh: `export GITHUB_TOKEN="$(cat /root/.hermes/.gh-token)"`,
        install_gh: "(command -v gh >/dev/null 2>&1) || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo 'deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt-get update -qq && apt-get install gh -y -qq)",
        clone_with: `git clone https://github.com/${owner}/${repo}.git`,
        instructions: "1. Run configure_git (one-time per session — sets up credential helper + bot identity via .gitconfig-bot include). 2. git clone/push/pull just work — credential helper reads the auto-synced token file. 3. For gh CLI: run configure_gh or install_gh if needed.",
      });
    } catch (e) {
      return jsonResult({ error: e.message });
    }
  }
);

// ── Repository Tools ────────────────────────────────────────────────

server.tool(
  "get_repository",
  "Get repository metadata",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => run(() => gh.getRepository(owner, repo))
);

server.tool(
  "get_file_contents",
  "Get contents of a file or directory from a repository",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    branch: z.string().optional(),
  },
  async ({ owner, repo, path, branch }) =>
    run(() => gh.getFileContents(owner, repo, path, branch))
);

server.tool(
  "create_or_update_file",
  "Create or update a single file in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    content: z.string().describe("File content"),
    message: z.string().describe("Commit message"),
    branch: z.string().optional(),
    sha: z.string().optional().describe("SHA of file being replaced (for updates)"),
  },
  async ({ owner, repo, path, content, message, branch, sha }) =>
    run(() => gh.createOrUpdateFile(owner, repo, path, content, message, branch, sha))
);

server.tool(
  "push_files",
  "Push multiple files in a single commit",
  {
    owner: z.string(),
    repo: z.string(),
    branch: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    message: z.string(),
  },
  async ({ owner, repo, branch, files, message }) =>
    run(() => gh.pushFiles(owner, repo, branch, files, message))
);

server.tool(
  "list_branches",
  "List branches in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, page, per_page }) =>
    run(() => gh.listBranches(owner, repo, page, per_page))
);

server.tool(
  "create_branch",
  "Create a new branch from an existing branch",
  {
    owner: z.string(),
    repo: z.string(),
    branch: z.string().describe("New branch name"),
    from_branch: z.string().describe("Source branch"),
  },
  async ({ owner, repo, branch, from_branch }) =>
    run(() => gh.createBranch(owner, repo, branch, from_branch))
);

// ── Issue Tools ─────────────────────────────────────────────────────

server.tool(
  "list_issues",
  "List open issues in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional(),
    labels: z.string().optional().describe("Comma-separated label names"),
    sort: z.enum(["created", "updated", "comments"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, ...opts }) => run(() => gh.listIssues(owner, repo, opts))
);

server.tool(
  "get_issue",
  "Get a specific issue by number",
  { owner: z.string(), repo: z.string(), issue_number: z.number() },
  async ({ owner, repo, issue_number }) => run(() => gh.getIssue(owner, repo, issue_number))
);

server.tool(
  "create_issue",
  "Create a new issue",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    milestone: z.number().optional(),
  },
  async ({ owner, repo, title, body, ...opts }) =>
    run(() => gh.createIssue(owner, repo, title, body, opts))
);

server.tool(
  "update_issue",
  "Update an existing issue (title, body, state, labels, assignees)",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  },
  async ({ owner, repo, issue_number, ...updates }) =>
    run(() => gh.updateIssue(owner, repo, issue_number, updates))
);

server.tool(
  "add_issue_comment",
  "Add a comment to an issue or pull request",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    body: z.string(),
  },
  async ({ owner, repo, issue_number, body }) =>
    run(() => gh.addIssueComment(owner, repo, issue_number, body))
);

server.tool(
  "list_issue_comments",
  "List comments on an issue",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, issue_number, ...opts }) =>
    run(() => gh.listIssueComments(owner, repo, issue_number, opts))
);

server.tool(
  "add_labels",
  "Add labels to an issue or PR",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    labels: z.array(z.string()),
  },
  async ({ owner, repo, issue_number, labels }) =>
    run(() => gh.addLabels(owner, repo, issue_number, labels))
);

server.tool(
  "remove_label",
  "Remove a label from an issue or PR",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    name: z.string(),
  },
  async ({ owner, repo, issue_number, name }) =>
    run(() => gh.removeLabel(owner, repo, issue_number, name))
);

server.tool(
  "list_labels",
  "List all labels in a repository",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => run(() => gh.listLabels(owner, repo))
);

server.tool(
  "create_label",
  "Create a new label in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    name: z.string(),
    color: z.string().describe("Hex color without #, e.g. 'ff0000'"),
    description: z.string().optional(),
  },
  async ({ owner, repo, name, color, description }) =>
    run(() => gh.createLabel(owner, repo, name, color, description))
);

// ── Pull Request Tools ──────────────────────────────────────────────

server.tool(
  "list_pull_requests",
  "List pull requests in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional(),
    sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    head: z.string().optional().describe("Filter by head branch (user:branch)"),
    base: z.string().optional().describe("Filter by base branch"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, ...opts }) => run(() => gh.listPullRequests(owner, repo, opts))
);

server.tool(
  "get_pull_request",
  "Get a specific pull request by number",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) => run(() => gh.getPullRequest(owner, repo, pull_number))
);

server.tool(
  "create_pull_request",
  "Create a new pull request",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    head: z.string().describe("Branch with changes"),
    base: z.string().describe("Branch to merge into"),
  },
  async ({ owner, repo, title, body, head, base }) =>
    run(() => gh.createPullRequest(owner, repo, title, body, head, base))
);

server.tool(
  "list_pull_request_files",
  "List files changed in a pull request",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) =>
    run(() => gh.listPullRequestFiles(owner, repo, pull_number))
);

server.tool(
  "get_pull_request_diff",
  "Get the diff of a pull request",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) =>
    run(() => gh.getPullRequestDiff(owner, repo, pull_number))
);

server.tool(
  "create_pull_request_review",
  "Create a review on a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    body: z.string().describe("Review summary"),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    comments: z
      .array(
        z.object({
          path: z.string(),
          position: z.number().optional(),
          line: z.number().optional(),
          body: z.string(),
        })
      )
      .optional()
      .describe("Inline review comments"),
  },
  async ({ owner, repo, pull_number, body, event, comments }) =>
    run(() => gh.createPullRequestReview(owner, repo, pull_number, body, event, comments || []))
);

server.tool(
  "merge_pull_request",
  "Merge a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    commit_title: z.string().optional(),
    commit_message: z.string().optional(),
    merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
  },
  async ({ owner, repo, pull_number, ...opts }) =>
    run(() => gh.mergePullRequest(owner, repo, pull_number, opts))
);

// ── Commit Tools ────────────────────────────────────────────────────

server.tool(
  "list_commits",
  "List commits on a repository or branch",
  {
    owner: z.string(),
    repo: z.string(),
    sha: z.string().optional().describe("Branch name or commit SHA"),
    path: z.string().optional().describe("Only commits touching this path"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, ...opts }) => run(() => gh.listCommits(owner, repo, opts))
);

// ── Search Tools ────────────────────────────────────────────────────

server.tool(
  "search_repositories",
  "Search for GitHub repositories",
  {
    query: z.string(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ query, page, per_page }) => run(() => gh.searchRepositories(query, page, per_page))
);

server.tool(
  "search_issues",
  "Search issues and pull requests across repositories",
  {
    query: z.string().describe("GitHub search query (e.g. 'repo:owner/name is:open label:bug')"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ query, page, per_page }) => run(() => gh.searchIssues(query, page, per_page))
);

server.tool(
  "search_code",
  "Search code across repositories",
  {
    query: z.string().describe("GitHub code search query"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ query, page, per_page }) => run(() => gh.searchCode(query, page, per_page))
);

// ── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
