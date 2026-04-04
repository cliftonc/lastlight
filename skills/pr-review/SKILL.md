---
name: pr-review
description: Review a GitHub pull request with structured feedback following project guidelines
version: 1.0.0
metadata:
  hermes:
    tags: [github, review, code-quality]
    category: maintenance
    requires_toolsets: [terminal]
---

# PR Review Skill

## When to Use
When asked to review a pull request, or when triggered by a cron job to check for unreviewed PRs.

## Procedure

1. **Fetch PR metadata** using the GitHub MCP tools:
   - Get the PR title, description, author, labels, and linked issues
   - Get the list of changed files and the diff

2. **Analyze the changes** systematically:
   - Read each changed file in context (not just the diff)
   - Check against the review guidelines in `.hermes.md`
   - Note the PR size (files changed, lines added/removed)

3. **Categorize findings** into four tiers:
   - **Critical**: Security issues, data loss, breaking changes — these block merge
   - **Important**: Missing tests, perf issues, type errors — should fix
   - **Suggestions**: Clarity, naming, DRY opportunities — nice to have
   - **Nits**: Style, formatting — optional

4. **Write the review comment**:
   - Start with a 1-2 sentence summary of what the PR does
   - List findings grouped by tier, with file:line references
   - Include inline code suggestions where helpful
   - End with an overall assessment: approve, request changes, or comment
   - Thank the contributor

5. **Submit the review** via GitHub API:
   - Use `create_pull_request_review` if available
   - Otherwise post as a regular comment

## Pitfalls
- Don't nitpick generated files (lock files, compiled assets)
- Don't repeat what linters/CI already catch
- Don't block PRs over style preferences alone
- Large PRs (>500 lines): focus on architecture and critical issues first

## Verification
- Confirm the review was posted by checking the PR comments
