---
name: issue-comment
description: Handle non-build maintainer comments on issues and PRs — close, label, answer questions, triage
version: 1.0.0
tags: [github, issues, comments]
---

# Issue Comment Skill

## When to Use
When a maintainer @mentions last-light on an issue or PR with a request that is NOT asking for code changes. Examples: close an issue, add labels, answer a question, check for duplicates, provide status, triage.

## Procedure

1. **Read the comment** carefully to understand what the maintainer is asking
2. **Read the issue/PR** context — title, body, existing labels, existing comments
3. **Execute the request**:
   - **Close/reopen**: Use `update_issue` to change state
   - **Label**: Use `add_labels` or `remove_label`
   - **Duplicate check**: Search for similar issues, comment with findings
   - **Answer/explain**: Read the relevant code and respond with a comment
   - **Triage**: Apply labels and priority based on the issue content
   - **Other**: Use best judgment — if unclear, comment asking for clarification
4. **Respond** with a brief comment confirming what was done

## Tool Usage

**Always use MCP tools** (`mcp_github_*`) for all GitHub operations. Never use `gh` CLI, `curl`, or raw HTTP requests. The MCP server handles authentication.

## Pitfalls
- NEVER make code changes, create branches, or push commits — this is an action-only skill
- Keep comments concise — one short confirmation, not a wall of text
- If the request actually needs code changes, comment suggesting the maintainer ask for a build instead
