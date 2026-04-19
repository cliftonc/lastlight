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
3. **Execute the request** — limited to lightweight, bounded actions only:
   - **Close/reopen**: `update_issue`
   - **Label**: `add_labels` or `remove_label`
   - **Duplicate check**: search similar issues, post one short comment with links
   - **Answer a direct question**: a brief reply (≤ 5 sentences), at most 1-2
     file reads. Do NOT survey the codebase to compile a report.
   - **Triage**: apply labels and priority based on the issue content
   - **Unclear / out of scope**: post one short comment asking the maintainer
     to clarify or to use `@last-light build` / `@last-light explore`. Do
     nothing else.
4. **Respond** with a brief comment confirming what was done

## Tool Usage

**Always use MCP tools** (`mcp_github_*`) for all GitHub operations. Never use `gh` CLI, `curl`, or raw HTTP requests. The MCP server handles authentication.

## Pitfalls
- NEVER make code changes, create branches, or push commits — this is an action-only skill
- NEVER perform the action the issue body describes. If the issue is titled
  "Security Review" and asks to "highlight issues and actively fix", that is a
  BUILD request — reply asking the maintainer to use `@last-light build`. Do
  NOT run a security audit (or any other multi-step investigation) from this
  skill, even if the maintainer's comment seems to greenlight it. The
  classifier owns intent routing; if a substantive request reached you, the
  correct response is to redirect, not to comply.
- Comments must be concise — one short confirmation, never a multi-section report
- Hard cap: at most 2 file reads and 1 outgoing comment per invocation
