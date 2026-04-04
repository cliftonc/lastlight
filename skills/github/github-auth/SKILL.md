---
name: github-auth
description: Set up GitHub authentication using the Last Light GitHub App. Token file and git config are auto-synced into sandboxes by Hermes via terminal.credential_files. Call setup_git_auth MCP tool, then run one configure command.
version: 3.0.0
author: Last Light
license: MIT
required_credential_files:
  - .gh-token
  - .gitconfig-bot
metadata:
  hermes:
    tags: [GitHub, Authentication, Git, Setup]
    related_skills: [github-pr-workflow, github-code-review, github-issues, github-repo-management]
---

# GitHub Authentication Setup

This agent authenticates as the **Last Light** GitHub App. Authentication uses credential files that are automatically synced into the terminal sandbox by Hermes before every command.

## How It Works

1. The launcher writes a fresh GitHub App installation token to `$HERMES_HOME/.gh-token` at startup
2. A pre-configured `.gitconfig-bot` in `$HERMES_HOME` contains the credential helper and bot identity
3. Both files are declared in `config.yaml` under `terminal.credential_files`
4. Hermes auto-syncs them into the sandbox (Modal, Docker, SSH, Daytona, local) before each command
5. The `setup_git_auth` MCP tool refreshes the token when needed

## Setup Procedure (Once Per Session)

### Step 1: Call the MCP tool

Call `setup_git_auth` with the target repo owner and name. This refreshes the token file.

### Step 2: Activate git config

Run the single command returned by `setup_git_auth`:

```bash
git config --global include.path /root/.hermes/.gitconfig-bot
```

(On local/SSH backends where `/root` doesn't exist, use `~/.hermes/.gitconfig-bot` instead — the tool returns the correct fallback command.)

That's it. Git clone, push, pull, and fetch all work transparently.

### Optional: gh CLI

If you need `gh` CLI:

```bash
# Set token for gh
export GITHUB_TOKEN="$(cat /root/.hermes/.gh-token 2>/dev/null || cat ~/.hermes/.gh-token 2>/dev/null)"

# Install gh if not present (Debian/Ubuntu containers)
(command -v gh >/dev/null 2>&1) || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt-get update -qq && apt-get install gh -y -qq)
```

## Token Refresh

The token expires after ~1 hour. If git operations start failing with auth errors:

1. Call `setup_git_auth` MCP tool again — it writes a fresh token
2. The credential helper reads the file on each git operation, so no reconfiguration needed
3. For `gh` CLI: re-export `GITHUB_TOKEN` from the file

## Verification

```bash
# Test credential helper
git credential fill <<< $'protocol=https\nhost=github.com'

# Test push access
git ls-remote https://github.com/owner/repo.git

# Check identity
git config user.name
git config user.email
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `fatal: Authentication failed` | Token expired — call `setup_git_auth` again |
| `cat: .gh-token: No such file` | `setup_git_auth` wasn't called, or Hermes hasn't synced yet (run any command first) |
| `remote: Permission denied` | GitHub App may not be installed on this repo |
| Token visible in logs | Never use `git remote set-url` with tokens — always use the credential helper |
