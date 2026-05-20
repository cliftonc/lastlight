<p align="center">
  <img src="transparent_clean.png" alt="Last Light" width="200" />
</p>

<h1 align="center">Last Light</h1>

<p align="center">
  <strong>GitHub Repository Maintenance Agent</strong><br/>
  <a href="https://lastlight.dev">lastlight.dev</a> · <a href="https://github.com/users/cliftonc/projects/4">Roadmap</a>
</p>

An AI agent that maintains GitHub repositories: triaging issues, reviewing PRs, monitoring repo health, and building features through an Architect → Executor → Reviewer development cycle.

Built on the [OpenCode](https://github.com/sst/opencode) runtime with a lightweight TypeScript harness for webhook ingestion, cron scheduling, and process management. Provider-agnostic — point `OPENCODE_MODEL` at any `provider/model` OpenCode supports (defaults to `openai/gpt-5.5`).

## Production Setup (Clean Server)

The fastest way to go from a bare server to a running Last Light instance:

```bash
npx lastlight setup
```

The setup wizard walks you through:

1. **GitHub App** — enter your App ID, Installation ID, and PEM key path
2. **Provider API key** — `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY`,
   whichever your `OPENCODE_MODEL` points at
3. **Webhook secret** — auto-generated if you don't have one
4. **Domain & TLS** — optional Caddy config for automatic HTTPS
5. **Slack** — optional bot token and app token for Slack integration
6. **Admin dashboard** — optional password protection

It writes `.env`, copies your PEM into the secrets directory, generates
`docker-compose.yml` and (optionally) a `Caddyfile`, then offers to build
and start the containers. When it's done you have a running instance ready
to receive webhooks.

> **Requires:** Node.js 20+, Docker, and a GitHub App already created
> (see [Create a GitHub App](#1-create-a-github-app) below).

---

## Quick Start (Local Dev)

### Prerequisites

- Node.js 20+
- Docker Desktop (or compatible)
- A GitHub App (see [Create a GitHub App](#1-create-a-github-app) below)
- An API key for whichever provider your chosen `OPENCODE_MODEL` uses
  (`OPENAI_API_KEY` for openai/…, `ANTHROPIC_API_KEY` for anthropic/…)

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

# Model provider auth — at least one
OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
```

### Run

`npm run dev` runs the harness on your host but spawns each agent task in a real Docker sandbox container, exactly like production. It is explicitly safe with your personal config:

| | Touched? |
|---|---|
| `~/.gitconfig` (your identity, credential helper) | ❌ skipped (`LASTLIGHT_LOCAL_DEV=1`) |
| `./data/sandbox-data/` | ✅ project-local bind-mount for sandbox containers |
| `./data/opencode-home/` | ✅ project-local; shim envelope jsonls for the dashboard live here |
| `./data/lastlight.db`, `./data/sandboxes/`, `./data/logs/` | ✅ project-local state, gitignored |

One-time setup — build the sandbox image:

```bash
docker compose --profile build-only build sandbox
```

Then run the harness (server + dashboard, with hot reload):

```bash
npm run dev            # both server and dashboard, concurrent
npm run dev:server     # server only
npm run dev:dashboard  # dashboard only
```

Both server scripts call `scripts/dev-local.sh`, which:
- Verifies Docker is running and the sandbox image exists
- Copies your `GITHUB_APP_PRIVATE_KEY_PATH` into `./data/sandbox-data/secrets/app.pem` (mode 600) so the in-sandbox GitHub MCP server can authenticate
- Sets `LASTLIGHT_LOCAL_DEV=1`, `SANDBOX_DATA_VOLUME=./data/sandbox-data`, `STATE_DIR=./data`, `OPENCODE_HOME_DIR=./data/sandbox-data/opencode-home`, and `ENABLE_DIRECT_FALLBACK=false`
- Starts the harness with `tsx watch src/index.ts`

#### Triggering work via the CLI

The CLI talks to the running server — it does not execute agents directly. Start the server first, then in another terminal:

```bash
# Cheap, safe defaults — single agent invocation
npx tsx src/cli.ts owner/repo#42                                # triage that one issue
npx tsx src/cli.ts https://github.com/owner/repo/issues/42      # same, full URL form
npx tsx src/cli.ts https://github.com/owner/repo/pull/99        # review that one PR
npx tsx src/cli.ts triage owner/repo                            # scan repo for new issues to triage
npx tsx src/cli.ts review owner/repo                            # scan repo for PRs to review
npx tsx src/cli.ts health owner/repo                            # weekly health report

# Expensive, opt-in — full Architect → Executor → Reviewer → PR cycle
npx tsx src/cli.ts build owner/repo#42
npx tsx src/cli.ts build https://github.com/owner/repo/issues/42
```

The default for a single-issue/PR shorthand is the **cheap** action (triage or review). Build cycles require the explicit `build` subcommand to opt in.

### Authentication

OpenCode picks credentials from `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` on the harness env. The harness forwards them into each sandbox container so workflow runs can reach the API.

---

## Docker Deployment

### Build and Run

```bash
docker-compose build agent
docker-compose up -d agent
```

### Secrets

Create a `secrets/` directory with your GitHub App credentials:

```bash
mkdir -p secrets
cp .env secrets/
cp your-app.private-key.pem secrets/
```

The entrypoint symlinks these into the container at startup. Your provider API key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) belongs in `secrets/.env`.

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
  lastlight.db              # SQLite: executions, workflow_runs, approvals, messaging sessions
  opencode-home/            # Dashboard shim jsonls
    projects/-app/*.jsonl   # Chat sessions (one per Slack thread)
    projects/-home-agent-workspace/*.jsonl  # Sandbox sessions
  opencode-serve/           # Working dir for the long-lived chat server
  sandboxes/                # Cloned repos per task
  logs/                     # Structured logs
  secrets/app.pem           # GitHub App PEM (mode 600) for sandbox access
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
| `OPENAI_API_KEY` | One of | API key when using `openai/…` models |
| `ANTHROPIC_API_KEY` | One of | API key when using `anthropic/…` models |
| `OPENCODE_MODEL` | No | Default model (default: `openai/gpt-5.5`) |
| `OPENCODE_MODELS` | No | Per-task overrides as JSON, e.g. `{"architect":"openai/gpt-5.4","triage":"anthropic/claude-haiku-4-5-20251001"}` |
| `OPENCODE_VARIANT` | No | Reasoning-effort default (OpenCode `--variant`), e.g. `minimal`, `medium`, `high`, `max`. Provider-agnostic — OpenCode maps to the right per-provider knob. |
| `OPENCODE_VARIANTS` | No | Per-task variant overrides as JSON, e.g. `{"architect":"high","reviewer":"high","triage":"minimal"}` |
| `OPENCODE_SERVE_PORT` | No | Port for the long-lived chat server (default: `4096`, bound to 127.0.0.1) |
| `OPENCODE_SERVE_LOGS` | No | Set to `1` to forward chat-server logs to harness stderr |
| `OPENCODE_BIN` | No | Override the opencode binary path (CI/dev) |
| `PORT` / `WEBHOOK_PORT` | No | Webhook listener port (default: `8644`) |
| `STATE_DIR` | No | Persistent state directory (default: `./data`) |
| `OPENCODE_HOME_DIR` | No | Where the dashboard reads sessions (default: `$STATE_DIR/opencode-home`) |
| `MAX_TURNS` | No | Reserved (unused by OpenCode; kept for API stability) |
| `BOT_LOGIN` | No | Bot login name for self-event filtering (default: `last-light[bot]`) |
| `LASTLIGHT_LOCAL_DEV` | No | Set to `1` on dev machines to skip `git config --global` writes from `git-auth.ts`. The installation token still reaches sandboxes via `GIT_TOKEN`. |
| `SANDBOX_DATA_VOLUME` | No | Either a Docker named volume name (default: `lastlight_agent-data`, used in production) or a host path (starts with `/`, `./`, `../`, or `~`) to bind-mount as `/data` inside each sandbox. Local dev uses `./data/sandbox-data`. |
| `ENABLE_DIRECT_FALLBACK` | No | If `true`, the harness spawns `opencode run` directly on the host when no sandbox is available. Local dev sets this to `false` to keep all agent work isolated in containers. |

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
| Workflow phases (Architect/Executor/Reviewer/PR) | `workflows/build.yaml` + `workflows/prompts/` |
| Event routing rules | `src/engine/router.ts` |
| Cron job schedules | `workflows/cron-*.yaml` |

---

## Architecture

```
┌─────────────────────────────────────────┐
│            Connector Layer              │
│  GitHub Webhook │ Slack Socket Mode     │
│        ↓        │         ↓             │
│     Event Normalizer (EventEnvelope)    │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│             Core Engine                 │
│  Event Router (deterministic)           │
│        ↓                                │
│  Workflow Runner (YAML phases)          │
│  - Sandbox: `opencode run --format json`│
│    in a Docker container per phase      │
│  - Chat: long-lived `opencode serve`,   │
│    one session per messaging thread     │
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
   - `comment.created` with `@last-light` from maintainer → routed by intent classifier (build / explore / triage / review / action)
3. **Workflow runner** loads the matching YAML, dispatches each phase to `executeAgent` (sandbox `opencode run`) or, for chat, `chatServer.postMessage` (long-lived `opencode serve`)
4. **Build workflow** runs a multi-phase cycle:
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
    index.ts                # Server entry point (also boots opencode serve)
    cli.ts                  # CLI client (talks to server)
    config.ts               # Config loader (.env)
    connectors/
      types.ts              # Connector + EventEnvelope interfaces
      github-webhook.ts     # GitHub webhook connector (Hono)
      index.ts              # Connector registry
    engine/
      router.ts             # Deterministic event → skill routing
      opencode-executor.ts  # Sandbox runtime: opencode run --format json
      opencode-chat-server.ts  # Long-lived opencode serve supervisor + client
      chat.ts               # Chat skill (calls the chat server)
      opencode-shim.ts      # Translates OpenCode events → Claude-SDK
                            # envelope jsonl for the dashboard reader
      profiles.ts           # ExecutorConfig / ExecutionResult types +
                            # GITHUB_PERMISSION_PROFILES + loadAgentContext
      llm.ts                # One-shot LLM helper for screen + classifier
      screen.ts             # Prompt-injection screener
      classifier.ts         # Intent classifier (build / explore / triage / …)
      git-auth.ts           # GitHub App git credential setup
    workflows/              # YAML workflow runner (see src/workflows/CLAUDE.md)
    sandbox/                # Docker sandbox lifecycle
    cron/
      scheduler.ts          # Cron with overlap protection
      jobs.ts               # Cron job registry
    admin/                  # Dashboard API (Hono) + session readers
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

  workflows/                # YAML workflow definitions
    build.yaml              # Architect → Executor → Reviewer → PR
    issue-triage.yaml
    pr-review.yaml
    repo-health.yaml
    cron-*.yaml             # Cron-kind triggers
    prompts/                # Per-phase prompt templates

  mcp-github-app/           # MCP server: 28+ GitHub tools via Octokit
    src/
      index.js              # MCP server entry (clone_repo, refresh_git_auth, etc.)
      auth.js               # GitHub App JWT + installation token
      github.js             # Octokit wrapper with retry/backoff

  deploy/
    entrypoint.sh                  # Docker entrypoint
    sandbox-entrypoint.sh          # Sandbox container entrypoint
    opencode-config.tmpl.json      # MCP servers config template for sandbox
  Dockerfile
  sandbox.Dockerfile
  docker-compose.yml
  Caddyfile                 # Reverse proxy for HTTPS
```

## Troubleshooting

### Server won't start

```bash
# Check .env is loaded
npm run dev:server
# Look for "Required environment variable not set" errors
```

### `npm run dev` says the sandbox image is missing

```bash
docker compose --profile build-only build sandbox
```

### Agent run fails with a quota / billing error

The runtime surfaces upstream errors as `error_api` with the verbatim provider message in the executions row:

- OpenAI: "Quota exceeded. Check your plan and billing details." → top up at https://platform.openai.com/account/billing
- Anthropic: "Credit balance is too low" → top up at https://console.anthropic.com

### Chat replies fail / `opencode serve` won't start

```bash
# Smoke-test the supervisor against your local opencode binary
npx tsx scripts/chat-smoke.mjs
```

If that two-turn probe succeeds in isolation, the issue is environmental (port collision, missing API key) rather than the supervisor itself. Set `OPENCODE_SERVE_LOGS=1` to forward serve logs to the harness stderr for deeper diagnosis.

### Webhooks not arriving

```bash
# Check health endpoint
curl http://localhost:8644/health

# Test with a fake POST (should return 401 — invalid signature)
curl -X POST http://localhost:8644/webhooks/github -d '{}'

# Check Docker port mapping
docker-compose ps
```

### Permission denied on MCP tools

The executor runs OpenCode with `--dangerously-skip-permissions` (non-interactive auto-approve). In Docker this requires a non-root user (the sandbox Dockerfile handles this automatically via gosu).
