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

To check permissions: check if the sender matches the repository owner from the payload (`repository.owner.login`). If not, check `sender.type` — only humans with maintainer access should trigger builds.

When triggered:
1. Use `mcp_github_add_issue_comment` to acknowledge the request
2. Use `mcp_github_get_issue` and `mcp_github_list_issue_comments` to read full context
3. Use `mcp_github_create_branch` to create a feature branch: `lastlight/{issue-number}-{short-description}`
4. Use `mcp_github_setup_git_auth` to configure git credentials
5. Clone the repo via terminal. **Use separate, short commands** — do not chain everything into one giant command:
   - `git clone --quiet https://github.com/{owner}/{repo}.git /tmp/{repo}`
   - `cd /tmp/{repo}`
   - `git checkout lastlight/{issue-number}-{short-description}`
6. **Work locally via terminal** — use `cat` to read files (not python scripts), edit code, install deps with `CI=true`, run tests
7. Commit locally: `git add . && git commit -m "feat: description (#issue)"`
8. **Use `mcp_github_push_files` to push changes** — do NOT use `git push` via terminal (auth doesn't work reliably). Collect the changed files and push them via MCP
9. Use `mcp_github_create_pull_request` to open the PR linking back to the issue
10. Use `mcp_github_add_issue_comment` to post the PR link on the original issue

**IMPORTANT**: Never use `python3` for reading files — use `cat`. Never use `git push` via terminal — use `mcp_github_push_files`.

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

Use the right tool for the job:

- **GitHub API calls** (comments, labels, PRs, issues): always use `mcp_github_*` tools. Never use `gh` CLI, `curl`, or raw HTTP requests for these.
- **Building features** (reading code, editing files, running tests): clone the repo and work locally via terminal. This is much faster than reading files one-by-one through MCP.
- **Git auth**: always call `mcp_github_setup_git_auth` before cloning or pushing.
- **Be fast**: webhook sessions have a timeout (default 30 min). Don't over-explore. Read what you need, make the changes, test, push.
- **Suppress spinners and progress bars**: always use quiet/non-interactive flags to avoid noisy output that floods the logs:
  - `git clone --quiet` / `git push --quiet`
  - `CI=true npm install` / `CI=true npm test`
  - `pip install --quiet`
  - Never use commands that produce progress spinners or animated output.

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
