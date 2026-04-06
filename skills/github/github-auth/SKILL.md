---
name: github-auth
description: >
  Git is pre-configured by the harness with GitHub App credentials.
  Clone, push, pull, and fetch work natively. No manual setup needed.
version: 3.0.0
tags: [github, auth, git]
---

# Git Authentication

**Git is already configured.** The harness sets up a global credential helper
and bot identity before any agent runs. Use git commands directly:

```bash
git clone https://github.com/owner/repo.git
cd repo
# ... make changes ...
git add -A && git commit -m "your message"
git push origin HEAD
```

## Token Refresh

The token expires after ~1 hour. If git operations fail with auth errors,
call the `refresh_git_auth` MCP tool:

```
refresh_git_auth(path: "./repo")
```

The credential helper is updated in place — no reconfiguration needed.

## Bot Identity

Commits are automatically attributed to:
- Name: `last-light[bot]`
- Email: `last-light[bot]@users.noreply.github.com`

## Verification

```bash
git ls-remote https://github.com/owner/repo.git   # test access
git config user.name                                # check identity
git config user.email
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `fatal: Authentication failed` | Token expired — call `refresh_git_auth` MCP tool |
| `remote: Permission denied` | GitHub App may not be installed on this repo |
| Token visible in logs | Never put tokens in git URLs — the credential helper handles auth |
