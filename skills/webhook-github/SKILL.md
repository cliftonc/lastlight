---
name: webhook-github
description: Handle incoming GitHub webhook events — triage issues, review PRs, respond to comments
version: 1.0.0
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

### Issue Comments

| Action | What to do |
|--------|-----------|
| `created` | Only respond if someone explicitly asks a question or requests help. Ignore status updates, thank-you messages, and general discussion |
| All other actions | Do nothing |

## Always Ignore

- Events from bot users (check if the author login ends in `[bot]` or is a known bot)
- Any action not explicitly listed above
- If in doubt, do nothing — silence is better than noise

## Response Format

Keep responses concise and actionable. Use the repository's existing label scheme. Reference specific line numbers when reviewing code. Be constructive, not nitpicky.

## Verification

After acting, confirm:
- Labels were applied (for issues)
- Review comment was posted (for PRs)
- Response is relevant and helpful (for comments)
