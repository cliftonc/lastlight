---
name: github-orchestrator
description: >
  Central coordinator for all GitHub work — routes events to the right action
  (triage, review, build) and orchestrates the Architect→Executor→Reviewer cycle
  for build requests. All work is tracked via GitHub issues.
version: 2.0.0
metadata:
  hermes:
    tags: [github, orchestrator, webhook, build-cycle, coordination]
    category: maintenance
    related_skills: [architect, assure-guardrails, subagent-driven-development, pr-review, issue-triage]
---

# GitHub Orchestrator

## When to Use

This skill is triggered automatically by incoming GitHub webhook events via the webhook platform, or invoked when a build request arrives from Discord, Slack, or CLI. It is the central coordinator for all GitHub work.

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

When triggered, follow the **Architect→Executor→Reviewer** cycle:

#### GitHub-First: Ensure a Tracking Issue Exists

Before any work begins, ensure there is a GitHub issue to coordinate on:
- **If triggered from an issue comment:** The issue already exists — use it.
- **If triggered from a PR comment:** Check if the PR links to an issue. If so, use that issue. If not, create one in the same repo with the PR context and link it.
- **If triggered from Discord or CLI:** Create an issue in the appropriate managed repo with the request as the body. Label it with the relevant type (bug, enhancement, etc.). Post all subsequent progress as comments on this issue.

All phases below post brief progress updates to this tracking issue.

#### Phase 0: Pre-Context Intake (you do this directly, not delegated)

1. Use `mcp_github_add_issue_comment` to acknowledge the request:
   `"Acknowledged — starting analysis. I'll post updates here as I work."`
2. Use `mcp_github_get_issue` and `mcp_github_list_issue_comments` to read issue context
3. **Clone the repo** — do this ONCE, upfront. Do NOT fetch files individually via
   `mcp_github_get_file_contents` (slow, one call per file). Clone and then read
   everything locally:
   ```
   mcp_github_setup_git_auth
   cd /root && rm -rf /tmp/{repo} && git clone --quiet https://github.com/{owner}/{repo}.git /tmp/{repo}
   ```
4. Read repo docs from the clone: `cat /tmp/{repo}/CLAUDE.md`, `AGENTS.md`,
   `README.md`, `package.json` via `terminal` or `read_file`. Do NOT use
   `mcp_github_get_file_contents` for files you can read from the clone.
5. Assemble a context snapshot:
   ```
   Task: {what the maintainer asked for}
   Desired outcome: {what success looks like}
   Known facts: {from issue body, comments, repo docs}
   Constraints: {repo conventions, test framework, existing patterns}
   Unknowns: {what needs investigation before coding}
   Likely touchpoints: {files/directories that will be affected}
   ```

#### Guardrails Check (between Phase 0 and Phase 1)

Before proceeding to architect analysis, run the `assure-guardrails` skill on the
cloned repo. This verifies that test framework, linting, and type checking are present.

- **READY** → proceed to Phase 1
- **BLOCKED** → create a guardrails issue, link it to the original task, fix foundations
  first via a separate build cycle, then resume the original task

#### Phase 1: Architect Analysis (delegate_task — read-only)

```python
delegate_task(
    goal="Architect analysis for build request",
    context="""
    ROLE: You are the ARCHITECT. Read-only analysis only. You MUST NOT edit
    files, create files, or run mutating commands. You may only read files,
    search code, and run read-only terminal commands.

    SETUP (run first — each delegated task gets its own sandbox):
    1. mcp_github_setup_git_auth
    2. rm -rf /tmp/{repo} && git clone --quiet https://github.com/{owner}/{repo}.git /tmp/{repo}
    3. Read /tmp/{repo}/CLAUDE.md and AGENTS.md first to understand repo conventions

    TASK: Analyze this build request and produce an implementation plan.

    CONTEXT SNAPSHOT:
    [INSERT CONTEXT FROM PHASE 0]

    OUTPUT FORMAT:
    1. Summary of what needs to change
    2. Files to modify (with line numbers and what to change)
    3. Implementation approach (step-by-step)
    4. Risks and edge cases to watch for
    5. Test strategy (what tests to write/run)
    6. Estimated complexity: simple / medium / complex
    """,
    toolsets=['terminal', 'file']
)
```

After the architect completes, post a summary to the issue:
```
mcp_github_add_issue_comment: "📋 **Architect analysis complete.**
- Complexity: {simple/medium/complex}
- Files to change: {list}
- Approach: {1-2 sentence summary}
- Risks: {key risks identified}

Starting implementation..."
```

#### Phase 2: Executor Implementation (delegate_task — full tools)

1. Use `mcp_github_setup_git_auth` to refresh the token and get the configure command
2. Run the `configure_git` command returned by `setup_git_auth` (one-time per session)
3. Dispatch the executor with the architect's plan:

```python
delegate_task(
    goal="Implement build request following architect plan",
    context="""
    ROLE: You are the EXECUTOR. Implement precisely what the architect's plan
    requires. Keep going until the task is fully resolved. Do not claim
    completion without fresh verification output (test results, build output).

    ARCHITECT'S PLAN:
    [INSERT ARCHITECT OUTPUT FROM PHASE 1]

    SETUP (do these first):
    - git clone --quiet https://github.com/{owner}/{repo}.git /tmp/{repo}
    - cd /tmp/{repo}
    - git checkout -b lastlight/{issue-number}-{short-description}

    EXECUTION:
    - Follow TDD: write failing test first, then implement, then verify
    - Use `cat` to read files (not python scripts)
    - Install deps with `CI=true` flag
    - Suppress spinners with `--quiet` flags

    COMMIT FORMAT (Lore-style):
    git add . && git commit -m "feat: {intent-first description} (#{issue})

    Tested: {test command} -> {result summary}
    Scope-risk: {low|medium|high}"

    PUSH:
    - git push --quiet -u origin HEAD 2>&1 | cat
    - IMPORTANT: Check output for "fatal:" — git push can exit 0 on failure
    - If push fails, report the error — do not retry

    OUTPUT: List of files changed, test results, commit hash, push status.
    """,
    toolsets=['terminal', 'file']
)
```

**If executor reports `git push` failure** (auth errors, output contains "fatal:"), fall back to the MCP path immediately — don't retry git:
- `mcp_github_create_branch` to create the remote branch from `main`
- `mcp_github_push_files` to push changed files via API (read each changed file's content first)
- Note: `mcp_github_push_files` cannot delete/rename files — prefer `git push` when possible
- Use `git diff HEAD~1 --name-only` to get the list of changed files, then read and push them

After the executor completes, post progress to the issue:
```
mcp_github_add_issue_comment: "🔨 **Implementation complete.** Running independent review...
- Files changed: {list}
- Tests: {pass/fail summary}
- Branch: `lastlight/{issue-number}-{slug}`"
```

#### Phase 3: Reviewer Verification (delegate_task — independent)

```python
delegate_task(
    goal="Independent review of build request implementation",
    context="""
    ROLE: You are the CODE REVIEWER. Independent verification of THIS
    COMMIT'S CHANGES ONLY. You have NO shared context with the executor.
    You do not fix code — you report issues. Every finding must cite
    file:line evidence.

    SETUP (run first — each delegated task gets its own sandbox):
    1. mcp_github_setup_git_auth
    2. rm -rf /tmp/{repo} && git clone --quiet -b {branch} https://github.com/{owner}/{repo}.git /tmp/{repo}
    3. cd /tmp/{repo}

    SCOPE — CRITICAL:
    Review ONLY the files changed in this commit. Do NOT review the rest
    of the repo. Get the exact scope first:

      git diff HEAD~1 --name-only   # list of changed files
      git diff HEAD~1               # the actual changes

    You may read context from unchanged files ONLY if needed to understand
    a specific change in the diff. Do not audit the repo, do not flag
    pre-existing issues in untouched files, do not suggest improvements
    to code that wasn't modified.

    ARCHITECT'S PLAN:
    [INSERT ARCHITECT OUTPUT FROM PHASE 1]

    CHECK (on changed files only):
    1. Does the implementation match the architect's plan?
    2. Do the new/modified tests pass? Run: {test command from CLAUDE.md}
    3. Any security concerns introduced by the changes?
    4. Any logic errors or missed edge cases in the new code?
    5. Is the new code quality acceptable for merge?

    DO NOT:
    - Review unchanged files
    - Flag pre-existing issues that weren't introduced by this commit
    - Suggest refactors to code outside the diff
    - Run linters or tests on files not in the diff

    OUTPUT FORMAT:
    - Verdict: APPROVED or REQUEST_CHANGES
    - Issues: [list with file:line references — all from changed files]
    - Suggestions: [non-blocking improvements to the changes]
    """,
    toolsets=['terminal', 'file']
)
```

After the reviewer completes, post the verdict to the issue:
```
mcp_github_add_issue_comment: "✅ **Review: APPROVED** — proceeding to PR."
# or
mcp_github_add_issue_comment: "🔄 **Review: REQUEST_CHANGES** — fixing issues...
- {list of issues found}"
```

#### Phase 4: Fix Loop (if REQUEST_CHANGES, max 2 cycles)

If the reviewer returns REQUEST_CHANGES:
1. Dispatch a new executor to fix ONLY the reported issues (not the original executor — fresh context)
2. Re-run the reviewer
3. After 2 failed cycles: push what we have, note remaining issues in the PR description

#### Phase 5: Create PR

After APPROVED (or after max fix cycles):
1. Use `mcp_github_create_pull_request` to open the PR linking back to the issue
2. If there were unresolved reviewer issues, note them in the PR description
3. Use `mcp_github_add_issue_comment` to post the PR link on the original issue

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

- **GitHub API calls** (comments, labels, PRs, issues, branches, PR creation): always use `mcp_github_*` tools. Never use `gh` CLI, `curl`, or raw HTTP requests for these.
- **Reading repo files**: clone the repo ONCE and read locally via `read_file`/`cat`/`grep`. Do NOT use `mcp_github_get_file_contents` for multiple files — it's one network round-trip per file. A single `git clone` gets everything at once.
- **Building features**: clone the repo, edit files, run tests locally via terminal. Push via git.
- **Git auth**: always call `mcp_github_setup_git_auth` before cloning or pushing.
- **Be fast — budget your iterations**: webhook sessions have a timeout (default 30 min) AND a tool-call iteration limit. Build requests now use the Architect→Executor→Reviewer cycle, which costs 3-5 `delegate_task` calls minimum. Each subagent gets its own iteration budget, but the orchestrator must still be efficient:
  - Keep Phase 0 (pre-context intake) lean — read only what's needed for the context snapshot
  - The architect subagent handles deep exploration, so don't duplicate that work
  - For simple requests (estimated complexity: simple), consider skipping the architect phase and going directly to executor + reviewer
  - Reserve orchestrator iterations for: context assembly, delegation, git auth, PR creation
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
