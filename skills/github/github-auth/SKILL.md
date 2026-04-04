---
name: github-auth
description: Set up GitHub authentication using the Last Light GitHub App. Configures git credential helper to read token from the synced credential file. Call setup_git_auth MCP tool first, then run configure commands.
version: 2.0.0
author: Last Light
license: MIT
required_credential_files:
  - .gh-token
metadata:
  hermes:
    tags: [GitHub, Authentication, Git, Setup]
    related_skills: [github-pr-workflow, github-code-review, github-issues, github-repo-management]
---

# GitHub Authentication Setup

This agent authenticates as the **Last Light** GitHub App. Authentication uses a credential file that is automatically synced into the terminal sandbox by Hermes.

## How It Works

1. The `setup_git_auth` MCP tool generates a fresh GitHub App installation token and writes it to `$HERMES_HOME/.gh-token`
2. Hermes automatically syncs this file into the sandbox before each command (Modal, Docker, etc.)
3. A git credential helper reads the token from the file — no tokens in URLs or commands

## Setup Procedure

### Step 1: Call the MCP tool

Call `setup_git_auth` with the target repo owner and name. This writes the token file on the host.

### Step 2: Configure git in the terminal

Run these commands ONCE per session:

```bash
# Set up credential helper to read from the synced token file
git config --global credential.helper '!f() { echo "password=$(cat /root/.hermes/.gh-token 2>/dev/null || cat ~/.hermes/.gh-token 2>/dev/null)"; echo "username=x-access-token"; }; f'

# Set bot identity for commits
git config --global user.name "lastlight[bot]"
git config --global user.email "APPID+lastlight[bot]@users.noreply.github.com"
```

(Replace APPID with the actual GitHub App ID from the setup_git_auth response.)

### Step 3: Use git normally

```bash
# Clone
git clone https://github.com/owner/repo.git

# Push
git push origin my-branch

# All git operations use the credential helper — no tokens visible
```

### Optional: Install gh CLI

If you need `gh` CLI for richer GitHub operations:

```bash
(command -v gh >/dev/null 2>&1) || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && apt-get update -qq && apt-get install gh -y -qq)

# gh reads GITHUB_TOKEN env var — set it from the token file
export GITHUB_TOKEN="$(cat /root/.hermes/.gh-token 2>/dev/null || cat ~/.hermes/.gh-token 2>/dev/null)"
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
git config --global user.name
git config --global user.email
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `fatal: Authentication failed` | Token expired — call `setup_git_auth` again |
| `cat: /root/.hermes/.gh-token: No such file` | `setup_git_auth` wasn't called, or credential file not synced |
| `remote: Permission denied` | GitHub App may not be installed on this repo |
| Token visible in logs | Never use `git remote set-url` with tokens — always use the credential helper |
