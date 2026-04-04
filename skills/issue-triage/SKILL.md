---
name: issue-triage
description: Triage GitHub issues — label, deduplicate, request info, and manage stale issues
version: 1.0.0
metadata:
  hermes:
    tags: [github, issues, triage]
    category: maintenance
    requires_toolsets: [terminal]
---

# Issue Triage Skill

## When to Use
When asked to triage issues, or on a scheduled basis to process new/stale issues.

## Procedure

### For new issues (no labels yet):

1. **Read the issue** carefully — title, body, and any linked PRs or issues
2. **Classify** the issue type:
   - Bug report → label `bug` + priority label
   - Feature request → label `enhancement`
   - Question → label `question`
   - Documentation → label `documentation`
3. **Check for duplicates** by searching existing issues with similar keywords
   - If duplicate found: comment linking to the original, add `duplicate` label, close
4. **Assess completeness**:
   - Bug without reproduction steps → add `needs-info`, comment asking for steps
   - Feature without use case → add `needs-info`, comment asking for context
5. **Set priority** based on severity and impact:
   - `p0-critical`: Security, data loss, service down
   - `p1-high`: Major feature broken, affects many users
   - `p2-medium`: Minor feature broken, workaround exists
   - `p3-low`: Cosmetic, edge case, nice-to-have
6. **Add helpful labels**: `good first issue` for simple fixes, `help wanted` for community

### For stale issues:

1. **Find issues** labeled `needs-info` with no activity for 14+ days
2. **Post a gentle reminder** asking if they still need help
3. **After 30 days** of no response: close with a kind message explaining why, and note they can reopen

## Tool Usage

**Always use MCP tools** (`mcp_github_*`) for all GitHub operations — listing issues, adding labels, posting comments, closing issues. Never use `gh` CLI, `curl`, or raw HTTP requests. The MCP server handles authentication.

## Pitfalls
- Don't close issues too aggressively — when in doubt, leave open
- Don't change priority on issues already triaged by maintainers
- Don't duplicate labels (check existing labels first)

## Verification
- List the actions taken (labels added, comments posted, issues closed)
- Confirm each action via the GitHub API response
