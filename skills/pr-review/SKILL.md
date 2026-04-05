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

2b. **For complex PRs** (>300 lines changed OR >5 files changed), use **architect-style deep analysis**:
   - Clone the repo locally via terminal (not just API reads)
   - Read changed files in FULL context — understand the surrounding code, not just the diff
   - Trace data flow through modified functions: what calls them, what they call
   - Check callers of modified functions for regression risk (`grep -rn "function_name"`)
   - Look for assumptions the PR makes about the rest of the codebase
   - Check if tests cover the actual risk areas, not just happy paths
   - For small PRs (<300 lines, <5 files), the standard API-only flow is sufficient

3. **Categorize findings** into four tiers:
   - **Critical**: Security issues, data loss, breaking changes — these block merge
   - **Important**: Missing tests, perf issues, type errors — should fix
   - **Suggestions**: Clarity, naming, DRY opportunities — nice to have
   - **Nits**: Style, formatting — optional

4. **Write the review comment**:
   - Start with a 1-2 sentence summary of what the PR does
   - List findings grouped by tier, with file:line references
   - Include inline code suggestions where helpful
   - For complex PRs, include an **Impact Analysis** section:
     - What other code paths are affected by these changes
     - What could break (with file:line refs to callers/dependents)
     - What assumptions the PR makes about the rest of the codebase
   - End with an overall assessment: approve, request changes, or comment
   - Thank the contributor

5. **Submit the review** via GitHub API:
   - Use `create_pull_request_review` if available
   - Otherwise post as a regular comment

## Tool Usage

**Always use MCP tools** (`mcp_github_*`) for all GitHub operations — fetching PRs, reading diffs, posting reviews. Never use `gh` CLI, `curl`, or raw HTTP requests. The MCP server handles authentication.

## Pitfalls
- Don't nitpick generated files (lock files, compiled assets)
- Don't repeat what linters/CI already catch
- Don't block PRs over style preferences alone
- Large PRs (>500 lines): focus on architecture and critical issues first
- Complex PRs: clone locally for deep analysis — API-only reads miss context

## Verification
- Confirm the review was posted by checking the PR comments
