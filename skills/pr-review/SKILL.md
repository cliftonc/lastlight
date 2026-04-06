---
name: pr-review
description: Review a GitHub pull request with structured feedback following project guidelines
version: 2.0.0
tags: [github, review, code-quality]
---

# PR Review Skill

## When to Use
When asked to review a pull request, or when triggered by a webhook/cron to check for unreviewed PRs.

## Procedure

### 0. Check if already reviewed

Before reviewing, **always check if the bot has already reviewed this PR**:
1. Use `list_pull_request_files` to get the PR head SHA
2. Use `get_pull_request` to check existing reviews
3. Look for reviews from `last-light[bot]` — if one exists on the current head SHA, **skip this PR**. Do NOT post a duplicate review.
4. If the PR has new commits since the last bot review, a re-review is appropriate.

### 1. Fetch PR metadata

Using MCP tools:
- Get the PR title, description, author, labels, and linked issues
- Get the list of changed files and the diff
- Skip PRs authored by `last-light[bot]` (self-review)

### 2. Analyze the changes

- Read each changed file in context (not just the diff)
- Check against the review guidelines in your agent context
- Note the PR size (files changed, lines added/removed)

**For complex PRs** (>300 lines changed OR >5 files changed):
- Clone the repo locally and read changed files in FULL context
- Trace data flow through modified functions
- Check callers of modified functions for regression risk
- Check if tests cover actual risk areas, not just happy paths

### 3. Categorize findings

- **Critical**: Security issues, data loss, breaking changes — block merge
- **Important**: Missing tests, perf issues, type errors — should fix
- **Suggestions**: Clarity, naming, DRY opportunities — nice to have
- **Nits**: Style, formatting — optional

### 4. Write the review comment

- 1-2 sentence summary of what the PR does
- Findings grouped by tier, with file:line references
- Inline code suggestions where helpful
- For complex PRs: impact analysis (affected code paths, regression risks)
- Overall assessment: approve, request changes, or comment
- Thank the contributor

### 5. Submit the review

Use `create_pull_request_review` MCP tool. Do NOT post as a regular comment.

## Tool Usage

**Always use MCP tools** for all GitHub operations. Never use `gh` CLI, `curl`, or raw HTTP requests.

## Pitfalls
- **Never review the same PR twice** at the same commit — always check first
- Don't nitpick generated files (lock files, compiled assets)
- Don't repeat what linters/CI already catch
- Don't block PRs over style preferences alone
- Skip PRs authored by the bot itself

## Verification
- Confirm the review was posted by checking the PR reviews list
