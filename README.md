<p align="center">
  <img src="transparent_clean.png" alt="Last Light" width="200" />
</p>

<h1 align="center">Last Light</h1>

<p align="center">
  <strong>GitHub Repository Maintenance Agent</strong><br/>
  <a href="https://lastlight.dev">lastlight.dev</a> · <a href="https://github.com/users/cliftonc/projects/4">Roadmap</a>
</p>

An AI agent that maintains GitHub repositories: triaging issues, reviewing PRs, monitoring repo health, and building features through an Architect → Executor → Reviewer development cycle.

Built on the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview) with a lightweight TypeScript harness for webhook ingestion, cron scheduling, and process management.

## Quick Start (Local Dev)

### Prerequisites

- Node.js 20+
- [Claude Code CLI](https://claude.ai/install.sh) installed and logged in (`claude login`)
- A GitHub App (see [Create a GitHub App](#1-create-a-github-app) below)

### Setup

```bash
git clone https://github.com/cliftonc/lastlight.git
cd lastlight
npm install
```

Copy and edit the environment file:

```bash
cp .env.example .env
```

Fill in the required values in `.env`:

```bash
# GitHub App (required)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./your-app.private-key.pem
GITHUB_APP_INSTALLATION_ID=789012

# Webhook secret (required for webhook mode)
WEBHOOK_SECRET=your-secret-here
```

### Run

```bash
# Start the server (with hot reload)
npm run dev

# In another terminal — trigger work via the CLI
npx tsx src/cli.ts https://github.com/owner/repo/issues/42   # build cycle
npx tsx src/cli.ts owner/repo#42                               # shorthand
npx tsx src/cli.ts triage owner/repo                           # triage scan
npx tsx src/cli.ts review owner/repo                           # PR review scan
npx tsx src/cli.ts health owner/repo                           # health report
```

The CLI talks to the running server — it does not execute agents directly. Start the server first.

### Authentication

Locally, the Agent SDK uses your Claude Code login (subscription). No API key needed — just make sure `claude login` works.

To use an API key instead, set `ANTHROPIC_API_KEY` in `.env`.

---

## Docker Deployment

### Build and Run

```bash
docker-compose build agent
docker-compose up -d agent
```

### First-Time Auth

The container needs Claude Code credentials. Log in interactively once:

```bash
docker exec -it lastlight-agent-1 claude login
```

Follow the URL in your browser to authenticate. The auth token persists in the Docker volume — it survives container restarts and rebuilds.

### Secrets

Create a `secrets/` directory with your GitHub App credentials:

```bash
mkdir -p secrets
cp .env secrets/
cp your-app.private-key.pem secrets/
```

The entrypoint symlinks these into the container at startup.

### Expose Webhooks

To receive GitHub webhooks, the server needs to be publicly reachable. The included Caddy config handles HTTPS:

```bash
# Set your domain
echo "DOMAIN=lastlight.example.com" >> .env

# Start both agent and caddy
docker-compose up -d
```

Or use [ngrok](https://ngrok.com) / [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for testing.

### State & Monitoring

All persistent state lives in a single Docker volume (`agent-data`), mounted at `/app/data`:

```
data/
  lastlight.db              # SQLite: execution log, rate limits
  claude-home/              # Claude auth + session JSONL logs
    projects/-app/*.jsonl   # Full audit trail per agent session
  sandboxes/                # Cloned repos per task
  logs/                     # Structured logs
  sessions/                 # (reserved)
```

Mount this volume or bind-mount the directory for monitoring tools to access session logs and the execution database.

### Trigger Work via CLI

With the container running:

```bash
# Health check
curl http://localhost:8644/health

# Trigger a build cycle
npx tsx src/cli.ts https://github.com/owner/repo/issues/42

# Trigger triage
npx tsx src/cli.ts triage owner/repo
```

---

## Setup Details

### 1. Create a GitHub App

1. Go to **https://github.com/settings/apps/new**
2. Fill in:
   - **Name**: your bot name (appears on comments/PRs with a `[bot]` badge)
   - **Homepage URL**: your repo URL
   - **Webhook URL**: `https://your-domain:8644/webhooks/github` (or leave blank for now)
   - **Webhook Secret**: a random string (same as `WEBHOOK_SECRET` in `.env`)
3. Set **permissions**:
   - **Issues**: Read & Write
   - **Pull Requests**: Read & Write
   - **Contents**: Read & Write
   - **Metadata**: Read
4. Subscribe to **events**: `Issues`, `Pull request`, `Issue comment`
5. Click **Create GitHub App**
6. Click **Generate a private key** — save the `.pem` file into the project directory
7. Note the **App ID** from the app settings page
8. Click **Install App** → install on your repos
9. Note the **Installation ID** from the URL: `github.com/settings/installations/{ID}`

### 2. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Yes | Path to `.pem` file |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Installation ID |
| `WEBHOOK_SECRET` | Yes | GitHub webhook signature secret |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (uses Claude login if not set) |
| `CLAUDE_MODEL` | No | Model to use (default: `claude-sonnet-4-6`) |
| `PORT` / `WEBHOOK_PORT` | No | Webhook listener port (default: `8644`) |
| `STATE_DIR` | No | Persistent state directory (default: `./data`) |
| `MAX_TURNS` | No | Max agent turns per invocation (default: `200`) |
| `BOT_LOGIN` | No | Bot login name for self-event filtering (default: `last-light[bot]`) |

### 3. Managed Repositories

Edit `agent-context/rules.md` to list repositories the bot manages:

```markdown
## Managed Repositories
- your-org/repo-one
- your-org/repo-two
```

### 4. Customize Behaviour

| What | Where |
|------|-------|
| Bot personality & communication style | `agent-context/soul.md` |
| Operational rules, review guidelines, triage rules | `agent-context/rules.md` |
| Skill definitions | `skills/*/SKILL.md` |
| Orchestrator phases (Architect/Executor/Reviewer) | `src/engine/orchestrator.ts` |
| Event routing rules | `src/engine/router.ts` |
| Cron job schedules | `src/cron/jobs.ts` |

---

## Architecture

```
┌─────────────────────────────────────────┐
│            Connector Layer              │
│  GitHub Webhook │ (future: Slack, etc.) │
│        ↓        │         ↓             │
│     Event Normalizer (EventEnvelope)    │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│             Core Engine                 │
│  Event Router (deterministic)           │
│        ↓                                │
│  Agent Executor (Claude Agent SDK)      │
│  - System prompt from agent-context/    │
│  - MCP tools (GitHub App)               │
│  - Skills (SKILL.md)                    │
│        ↓                                │
│  Sandboxes (git clone per task)         │
│  Cron Scheduler (health reports)        │
│  State DB (SQLite execution log)        │
└─────────────────────────────────────────┘
```

### How Events Flow

1. **GitHub webhook** → connector verifies signature, filters noise (bot events, edits, labels), normalizes to `EventEnvelope`
2. **Router** maps event type to skill deterministically (no LLM in the routing loop):
   - `issue.opened` → `issue-triage`
   - `pr.opened` → `pr-review`
   - `comment.created` with `@last-light` from maintainer → `github-orchestrator`
3. **Executor** spawns a Claude Agent SDK session with the skill prompt, MCP tools, and agent context
4. **Orchestrator** (for build requests) runs a multi-phase cycle:
   - Phase 1: **Architect** — read-only analysis, writes plan to `.lastlight/issue-N/architect-plan.md`
   - Phase 2: **Executor** — TDD implementation following the plan
   - Phase 3: **Reviewer** — independent verification (no shared context with executor)
   - Phase 4: **Fix loop** (up to 2 cycles if reviewer requests changes)
   - Phase 5: **Create PR**

### Cron

When webhooks are enabled, only the weekly health report runs on cron (issue/PR events arrive in real-time via webhooks). Without webhooks, triage and PR review also run on cron.

| Job | Schedule | Condition |
|-----|----------|-----------|
| Triage new issues | Every 15 min | Only without webhooks |
| Check PRs for review | Every 30 min | Only without webhooks |
| Weekly health report | Mondays 9am | Always |

---

## Project Structure

```
lastlight/
  src/
    index.ts                # Server entry point
    cli.ts                  # CLI client (talks to server)
    config.ts               # Config loader (.env)
    connectors/
      types.ts              # Connector + EventEnvelope interfaces
      github-webhook.ts     # GitHub webhook connector (Hono)
      index.ts              # Connector registry
    engine/
      router.ts             # Deterministic event → skill routing
      executor.ts           # Agent SDK query() wrapper
      orchestrator.ts       # Architect → Executor → Reviewer cycle
      agents.ts             # Subagent role definitions
      git-auth.ts           # GitHub App git credential setup
    worktree/
      manager.ts            # Git worktree per-task isolation
    cron/
      scheduler.ts          # Cron with overlap protection
      jobs.ts               # Job definitions
    state/
      db.ts                 # SQLite execution tracking

  agent-context/
    soul.md                 # Bot personality, principles, communication style
    rules.md                # Operational rules, managed repos, review guidelines

  skills/
    github-orchestrator/    # Central build cycle coordinator
    issue-triage/           # Issue labeling and triage
    pr-review/              # Structured PR review
    repo-health/            # Health reports
    github/                 # GitHub API workflow skills
    software-development/   # Dev skills (architect, TDD, debugging)

  mcp-github-app/           # MCP server: 28+ GitHub tools via Octokit
    src/
      index.js              # MCP server entry (clone_repo, refresh_git_auth, etc.)
      auth.js               # GitHub App JWT + installation token
      github.js             # Octokit wrapper with retry/backoff

  deploy/
    entrypoint.sh           # Docker entrypoint
  Dockerfile
  docker-compose.yml
  Caddyfile                 # Reverse proxy for HTTPS
```

## Troubleshooting

### Server won't start

```bash
# Check .env is loaded
npm run dev
# Look for "Required environment variable not set" errors
```

### Agent exits with code 1

```bash
# Check if Claude is logged in
claude --version && claude -p "hello"

# In Docker: check auth persisted
docker exec lastlight-agent-1 claude -p "hello"
# If it fails, re-login:
docker exec -it lastlight-agent-1 claude login
```

### Webhooks not arriving

```bash
# Check health endpoint
curl http://localhost:8644/health

# Test with a fake POST (should return 401 — invalid signature)
curl -X POST http://localhost:8644/webhooks/github -d '{}'

# Check Docker port mapping
docker-compose ps
```

### Credit balance / rate limit errors

If you see "Credit balance is too low", either:
- Top up at https://console.anthropic.com (API key mode)
- Remove `ANTHROPIC_API_KEY` from `.env` to use your Claude subscription instead

### Permission denied on MCP tools

The executor runs with `bypassPermissions` mode. In Docker, this requires running as a non-root user (the Dockerfile handles this automatically).
