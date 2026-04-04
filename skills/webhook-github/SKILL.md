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
3. Use `mcp_github_setup_git_auth` to refresh the token and get the configure command
4. Run the `configure_git` command returned by `setup_git_auth` (one-time per session)
5. Clone the repo via terminal. **Use separate, short commands** — do not chain everything into one giant command:
   - `git clone --quiet https://github.com/{owner}/{repo}.git /tmp/{repo}`
   - `cd /tmp/{repo}`
   - `git checkout -b lastlight/{issue-number}-{short-description}`
6. **Work locally via terminal** — use `cat` to read files (not python scripts), edit code, install deps with `CI=true`, run tests
7. Commit locally: `git add . && git commit -m "feat: description (#issue)"`
8. Push via git: `git push --quiet -u origin HEAD 2>&1 | cat`
   - **IMPORTANT**: Always pipe to `cat` and **check the output text for "fatal:"** — `git push` can exit 0 even when the push fails (e.g. credential helper errors)
9. Use `mcp_github_create_pull_request` to open the PR linking back to the issue
10. Use `mcp_github_add_issue_comment` to post the PR link on the original issue

**If `git push` fails** (auth errors, or output contains "fatal:"), fall back to the MCP path immediately — don't retry git:
- `mcp_github_create_branch` to create the remote branch from `main`
- `mcp_github_push_files` to push changed files via API (read each changed file's content first)
- Note: `mcp_github_push_files` cannot delete/rename files — prefer `git push` when possible
- Use `git diff HEAD~1 --name-only` to get the list of changed files, then read and push them

**IMPORTANT**: Never use `python3` for reading files — use `cat`. Suppress spinners with `--quiet` flags.

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
- **Be fast — budget your iterations**: webhook sessions have a timeout (default 30 min) AND a tool-call iteration limit. Build requests are iteration-heavy (clone, explore, edit, test, push, PR). Minimize exploratory reads:
  - Use `execute_code` to batch multiple grep/file reads into one tool call
  - Once you understand the pattern from 1-2 files, apply changes to all files without re-reading each one individually
  - Use `search_files` with targeted patterns instead of reading whole files
  - Reserve iterations for: editing, building/testing, pushing, and creating the PR
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
