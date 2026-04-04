---
name: webhook-github
description: Handle incoming GitHub webhook events — triage issues, review PRs, respond to comments, build features on request
version: 1.1.0
metadata:
  hermes:
    tags: [github, webhook, maintenance]
    category: maintenance
---

# GitHub Webhook Handler

## When to Use

This skill is triggered automatically by incoming GitHub webhook events via the webhook platform. Do not run it manually.

## Event Handling Rules

You will receive a GitHub event with an event type, action, repository, and payload. Follow these rules:

### Issues

| Action | What to do |
|--------|-----------|
| `opened` | Triage the issue: classify type (bug, feature, question), add appropriate labels, check for duplicates, ask for missing info if needed |
| `reopened` | Check if the reopen reason is clear. If not, ask the author why they reopened it |
| All other actions | Do nothing. Do not respond to `edited`, `closed`, `labeled`, `unlabeled`, `assigned`, etc. |

### Pull Requests

| Action | What to do |
|--------|-----------|
| `opened` | Review the PR: read the diff, provide structured feedback (critical > important > suggestions > nits) |
| All other actions | Do nothing |

### Issue Comments (`issue_comment`)

| Action | What to do |
|--------|-----------|
| `created` | Check the rules below in order: |

**@mention from a maintainer — build request:**
If the comment contains the bot's @mention name (provided in the prompt as "Bot mention name") AND the commenter has `admin` or `maintain` permission on the repo, treat it as a work request.

**IMPORTANT: Use MCP tools for all GitHub operations. Do NOT use `gh` CLI, `curl`, or raw HTTP requests.**

To check permissions, use the `mcp_github_search_issues` or similar MCP tool. If no direct permission-check tool exists, check if the sender matches the repository owner from the payload (`repository.owner.login`).

When triggered:
1. Use `mcp_github_add_issue_comment` to acknowledge the request on the issue
2. Use `mcp_github_get_issue` and `mcp_github_list_issue_comments` to read full context
3. Use `mcp_github_get_file_contents` to read relevant source files
4. Use `mcp_github_create_branch` to create a feature branch: `lastlight/{issue-number}-{short-description}`
5. Implement the changes and use `mcp_github_push_files` to commit them
6. Use `mcp_github_create_pull_request` to open a PR linking back to the issue
7. Use `mcp_github_add_issue_comment` to post the PR link on the original issue

Do NOT clone repos via terminal. Do NOT install packages via apt. Do NOT use `gh` CLI. All GitHub operations go through MCP tools.

**@mention from a non-maintainer:**
Reply politely that you only take build requests from repository maintainers.

**No @mention:**
Only respond if someone explicitly asks a question or requests help. Ignore status updates, thank-you messages, and general discussion.

| All other actions | Do nothing |

### PR Review Comments (`pull_request_review_comment`, `pull_request_review`)

| Action | What to do |
|--------|-----------|
| `created` / `submitted` | Only respond if someone asks a question or requests clarification. Do not re-review the whole PR |
| All other actions | Do nothing |

## Tool Usage

**Always use MCP tools** (`mcp_github_*`) for GitHub operations. Never fall back to:
- `gh` CLI
- `curl` or `python` HTTP requests
- `git clone` via terminal
- Installing packages via `apt`

The MCP server already has authentication configured. Use it.

## Always Ignore

- Events where `sender.type` is `Bot`, or sender login ends in `[bot]`
- Events where the sender matches the bot mention name
- Any action not explicitly listed above
- If in doubt, do nothing — silence is better than noise

## Response Format

Keep responses concise and actionable. Use the repository's existing label scheme. Reference specific line numbers when reviewing code. Be constructive, not nitpicky.

## Verification

After acting, confirm:
- Labels were applied (for issues)
- Review comment was posted (for PRs)
- Response is relevant and helpful (for comments)
- PR was opened and linked to the issue (for build requests)
