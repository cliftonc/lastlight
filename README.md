<p align="center">
  <img src="transparent_clean.png" alt="Last Light" width="200" />
</p>

<h1 align="center">Last Light</h1>

<p align="center">
  <strong>GitHub Repository Maintenance Agent</strong><br/>
  <a href="https://lastlight.dev">lastlight.dev</a> · <a href="https://github.com/users/cliftonc/projects/4">Roadmap</a>
</p>

A [Hermes Agent](https://hermes-agent.nousresearch.com/) bot that maintains GitHub repositories: triaging issues, reviewing PRs, monitoring repo health, and building features.

## Setup

### 1. Install Hermes Agent

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.zshrc
```

### 2. Create a GitHub App

The bot posts as its own identity (custom name, avatar, `[bot]` badge) via a GitHub App.

1. Go to **https://github.com/settings/apps/new**
2. Fill in:
   - **Name**: "Last Light Bot" (or whatever you want the bot to appear as)
   - **Homepage URL**: your repo URL
   - **Webhook**: leave unchecked for now
3. Set **permissions**:
   - Issues: **Read & Write**
   - Pull Requests: **Read & Write**
   - Contents: **Read & Write** (needed to create branches/PRs)
   - Metadata: **Read**
4. Click **Create GitHub App**
5. On the app page, click **Generate a private key** — save the `.pem` file into this directory
6. Note the **App ID** from the app settings page
7. Click **Install App** → install on your repos (or all repos)
8. Note the **Installation ID** from the URL: `github.com/settings/installations/{THIS_NUMBER}`

### 3. Configure Secrets

```bash
cp .env.example .env
cp config.yaml.example config.yaml
```

Edit `.env` and fill in:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./your-app-name.private-key.pem
GITHUB_APP_INSTALLATION_ID=789012
```

The bot auto-generates and caches short-lived tokens from these credentials. Tokens refresh automatically when they near expiry.

You also need an LLM provider key. The default config uses OpenAI Codex (`gpt-5.4`). The `.env` copied from `~/.hermes/.env` should already have your credentials — check that `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` are set if you want Modal terminal backend.

### 4. Configure Modal (optional — for sandboxed code execution)

If you want the bot to write and test code in an isolated environment:

1. Sign up at https://modal.com and get your token
2. In `.env`, set:
   ```bash
   MODAL_TOKEN_ID=ak-...
   MODAL_TOKEN_SECRET=as-...
   ```
3. In `config.yaml`, change terminal backend:
   ```yaml
   terminal:
     backend: modal
   ```

Without Modal, the bot runs commands locally (`backend: local` — the current default).

### 5. Add Your Repositories

Edit `.hermes.md` and list your repos under `## Managed Repositories`:

```markdown
## Managed Repositories
- cliftonc/drizzle-cube
- cliftonc/drizby
```

### 6. Run It

```bash
./lastlight
```

## Usage

### Interactive

```bash
./lastlight                    # chat with the bot
./lastlight -c                 # resume last session
```

Then ask it things:
```
> Review PR #42 on cliftonc/drizzle-cube
> Triage open issues on cliftonc/drizby
> Build a feature to add pagination to the /api/users endpoint on cliftonc/drizzle-cube
> What's the health of my repos?
```

### Single Command

```bash
./lastlight chat -q "Review the latest PR on cliftonc/drizzle-cube"
./lastlight chat -s pr-review -q "Review PR #15 on cliftonc/drizby"
```

### Slash Commands (inside a session)

```
/pr-review Review PR #15 on cliftonc/drizby
/issue-triage Process new issues on cliftonc/drizzle-cube
/repo-health Weekly report for all repos
```

### Gateway (Discord/Telegram/Slack)

Run the bot as a persistent service connected to a messaging platform:

```bash
./lastlight gateway setup      # interactive wizard
./lastlight gateway            # run in foreground
./lastlight gateway install    # install as a system service (launchd on macOS)
```

### GitHub Webhooks

React to repo events (new issues, PRs, comments) in real time. This uses a single webhook endpoint — your GitHub App sends all events to it, and the agent decides what to act on based on the prompt.

Add to `config.yaml`:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      host: "0.0.0.0"
      port: 8644
      routes:
        github:
          secret: "your-webhook-secret"
          events: ["issues", "pull_request", "issue_comment"]
          skills: ["github-orchestrator"]
          prompt: |
            GitHub event: {_event_type}, action: {action}
            Repository: {repository.full_name}
            Issue/PR: #{issue.number} {issue.title}
            Author: {issue.user.login}
            Body: {issue.body}
          deliver: log
```

The `prompt` passes event data to the agent. The logic for what to act on lives in `skills/github-orchestrator/SKILL.md` — edit that file to customise the behaviour.

Then configure your GitHub App's webhook:
- **URL**: `http://your-host:8644/webhooks/github`
- **Secret**: same as in `config.yaml`

The endpoint must be publicly reachable — use [ngrok](https://ngrok.com) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) if running locally.

**Delivery options:**

| Option | What it does |
|--------|-------------|
| `log` | Log to gateway output (good for testing) |
| `github_comment` | Post back on the issue/PR that triggered it |
| `discord` / `slack` / `telegram` | Forward to your messaging channel |

Filter by event type with `events` — only listed types trigger the agent. Finer-grained filtering (ignore edits, bot authors, etc.) is handled by the agent via the prompt.

## Scheduled Jobs (Cron)

Four cron jobs are pre-configured in `cron/jobs.json`:

| Job | Schedule | What it does |
|-----|----------|--------------|
| Refresh GitHub Token | Every 50 min | Restarts MCP server with a fresh token |
| Triage New Issues | Every 15 min | Labels and triages unlabeled issues |
| Check PRs Awaiting Review | Every 30 min | Reviews unreviewed PRs |
| Weekly Health Report | Mondays 9am | Summary of open issues, PR backlog, stale items |

These run when the agent is active. Manage them inside a session with `/cron`, or edit `cron/jobs.json` directly.

## Project Structure

```
lastlight/
├── lastlight                      # Launcher (sets HERMES_HOME, generates GitHub token)
├── config.yaml                  # Your local config (not committed — copy from config.yaml.example)
├── config.yaml.example          # Template config with all options documented
├── .env                         # Secrets: GitHub App credentials, LLM keys, Modal tokens
├── .env.example                 # Template for .env
├── SOUL.md                      # Agent personality — who the bot is, how it behaves
├── .hermes.md                   # Project context — repos, review guidelines, triage rules
│
├── scripts/
│   └── github-app-token.sh      # Generates/caches GitHub App installation tokens
│
├── mcp-github-app/              # Custom MCP server with native GitHub App auth
│   └── src/
│       ├── index.js             # MCP server entry point (28 tools)
│       ├── auth.js              # GitHub App JWT + installation token with auto-refresh
│       └── github.js            # Octokit wrapper with token rotation
│
├── skills/                      # Agent skills (slash commands)
│   ├── github/                  # GitHub workflows (auth, PRs, issues, code review)
│   ├── software-development/    # Dev workflows (TDD, debugging, code review, planning)
│   ├── devops/                  # Webhooks, deployment
│   ├── mcp/                     # MCP server management
│   ├── pr-review/               # Custom: structured PR review
│   ├── issue-triage/            # Custom: issue labeling and triage
│   └── repo-health/             # Custom: repository health reports
│
├── cron/jobs.json               # Scheduled jobs
├── memories/                    # Agent's persistent memory
├── sessions/                    # Conversation history
└── logs/                        # Runtime logs
```

## Customization

### Editing Review Guidelines

Edit `.hermes.md` → `## Review Guidelines`. The four-tier system (Critical > Important > Suggestions > Nits) is used by the PR review skill. Add or remove rules as needed.

### Editing Issue Triage Rules

Edit `.hermes.md` → `## Issue Triage Rules`. Adjust stale thresholds, label names, and priority definitions.

### Editing the Agent Personality

Edit `SOUL.md` to change tone, communication style, and behavioral principles. Changes take effect on the next message — no restart needed.

### Editing Skills

Skills live in `skills/` as directories containing a `SKILL.md` file. The format:

```markdown
---
name: my-skill
description: One-line description shown in /skills list
version: 1.0.0
metadata:
  hermes:
    tags: [github, code]
    category: maintenance
---

# Skill Name

## When to Use
Trigger conditions.

## Procedure
Step-by-step instructions the agent follows.

## Pitfalls
Known failure modes.

## Verification
How to confirm it worked.
```

Custom skills (`pr-review`, `issue-triage`, `repo-health`) are in the top level of `skills/`. The bundled ones (`github/`, `software-development/`, etc.) contain sub-skills in subdirectories.

### Creating a New Skill

```bash
mkdir skills/my-new-skill
# Create skills/my-new-skill/SKILL.md following the format above
```

Or let the agent create one for you — it can write skills via the `skill_manage` tool during a session.

### Changing the LLM Model

Edit `config.yaml`:
```yaml
model:
  default: gpt-5.4              # current default
  provider: openai-codex
```

Or switch at runtime: `./lastlight chat --model "anthropic/claude-sonnet-4"`

### Architectural Guardrails for Repos

Put a `CLAUDE.md` in each managed repo with coding conventions, boundaries, and testing requirements. Hermes automatically reads it when working in that repo. See `templates/AGENTS.md.template` for a starting point.

## How It Works

The `./lastlight` script sets `HERMES_HOME` to this directory, so all config, skills, memory, and state are local — your global `~/.hermes/` config is untouched. You can run both side by side:

```bash
hermes        # your personal agent (uses ~/.hermes/)
./lastlight     # the maintenance bot (uses this directory)
```

A custom MCP server (`mcp-github-app/`) provides GitHub API access with native GitHub App authentication. Tokens refresh automatically inside the running process — no restarts needed. The `setup_git_auth` tool writes a credential file that Hermes syncs into sandboxed environments (Modal, Docker) so git push/pull works transparently.

## Troubleshooting

```bash
# Test GitHub App token generation
bash scripts/github-app-token.sh

# Check config
./lastlight config

# List available tools (should show mcp_github_* tools)
./lastlight chat -q "/tools"

# Debug mode
./lastlight chat --verbose

# Diagnostics
./lastlight doctor
```
