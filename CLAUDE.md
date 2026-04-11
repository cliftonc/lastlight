# Last Light — Development Guide

A GitHub repository maintenance agent. It listens for events (GitHub webhooks
and Slack messages), classifies them, and runs an AI agent against a target
repo via the Anthropic Agent SDK. Everything non-trivial — triage, PR review,
the full Architect→Executor→Reviewer build cycle, health reports — is
expressed as a **YAML workflow** the harness executes phase-by-phase.

## Repo layout

```
src/
  index.ts              Main entry — wires connectors, registers the event
                        handler, starts the cron scheduler and admin dashboard.
  config.ts             Env parsing (ports, models, MCP config, GitHub App).
  cli.ts                Thin client that POSTs to a running server.
  connectors/           Platform abstraction — every event source emits an
                        EventEnvelope so the engine never sees raw payloads.
    github-webhook.ts   GitHub App webhook → EventEnvelope.
    slack/              Slack Socket Mode + mrkdwn formatter.
    messaging/          Base class for all messaging platforms
                        (slack now, discord later). Owns SessionManager — the
                        per-thread conversation store.
  engine/
    router.ts           Deterministic, code-based routing of EventEnvelope
                        → { skill, context }. Classifies build intent via a
                        small LLM classifier. No LLM decides the tab.
    executor.ts         Runs one agent session in a Docker sandbox. Parses
                        stream-json output for tokens / cost / session id /
                        usage metrics.
    chat.ts             In-process chat skill. Runs query() directly (no
                        sandbox) for low-latency Slack replies, RESUMES the
                        same Agent SDK session per Slack thread via the
                        `resume` option, and returns full ChatResult metrics.
    classifier.ts       Tiny LLM call that decides "is this comment asking
                        me to build something?". In-process.
    git-auth.ts         GitHub App JWT → installation token. Supports
                        permission downscoping (contents/issues/pull_requests/
                        metadata read vs write) and a per-token repo allowlist.
    github.ts           Harness-side Octokit client (post comments, create
                        issues, react to comments). Not used by agents.
  workflows/            See src/workflows/CLAUDE.md for the full runner
                        story. Loads YAML definitions, executes phases
                        (linear or DAG), manages resume, approval gates,
                        loop iterations.
  sandbox/              Docker-based isolation for agent runs. One container
                        per task, mounted data volume, hardened path checks
                        (gitdir mounts validated against sandbox root,
                        taskId traversal rejected).
  worktree/             Small helper for per-task git worktree setup inside
                        the sandbox. Implementation detail of `sandbox/`.
  admin/                Admin dashboard API (Hono) + SessionReader /
                        ChatSessionReader / auth / Slack OAuth login.
                        SessionReader scans claude-home/projects/-<cwd>/ for
                        sandbox runs; ChatSessionReader is DB-backed and
                        groups by Slack thread.
  state/
    db.ts               SQLite tables: executions, workflow_runs,
                        workflow_approvals, rate_limits, system_status,
                        plus daily/hourly stat rollups.
  cron/                 node-cron scheduler. Each tick dispatches a
                        cron-kind workflow via the same runner.

workflows/              YAML workflow definitions consumed by the loader.
                        build.yaml, pr-fix.yaml, pr-review.yaml,
                        issue-triage.yaml, issue-comment.yaml,
                        repo-health.yaml, cron-*.yaml.
workflows/prompts/      Prompt templates referenced from phases via
                        `prompt: prompts/architect.md` etc. Rendered with
                        the template engine in src/workflows/templates.ts.

skills/                 SKILL.md files loaded when a phase sets `skill:`
                        instead of `prompt:`. Single-phase workflows
                        (triage / review / health) use this path.
agent-context/          *.md files concatenated and prepended as the system
                        prompt for every agent session — the bot's
                        "personality" plus hard rules.

mcp-github-app/         Standalone MCP server that exposes GitHub tools to
                        the agent. Uses the GitHub App installation token
                        by default; falls back to a GITHUB_TOKEN env var
                        only when App env vars are unset (low-trust
                        sandbox fallback).
deploy/                 Docker entrypoints, Caddyfile, systemd helpers.
dashboard/              React+Vite admin SPA, served from /admin at runtime.
```

## Key concepts

- **EventEnvelope** (`src/connectors/types.ts`) — canonical event shape.
  Every connector normalizes to it; the engine only ever sees EventEnvelopes.
- **Workflow** — a YAML file listing phases. The runner knows nothing about
  "build" vs "triage" — it just executes phases in order (or as a DAG). See
  `src/workflows/CLAUDE.md`.
- **Two execution modes**:
  - **Sandbox** — workflow phases run inside a Docker sandbox (`src/sandbox`)
    with a minted per-run GitHub token. Every phase writes an `executions`
    row. Used by all YAML workflows.
  - **In-process** — the chat skill (`src/engine/chat.ts`) runs the Agent
    SDK directly in the harness process for low-latency Slack replies. Each
    turn still writes an `executions` row (triggerType=`chat`, skill=`chat`,
    triggerId=messaging session id) and the SDK session is resumed per
    Slack thread so one thread = one growing jsonl.
- **Two session stores**:
  - **Sandbox sessions** — Agent SDK jsonls on disk at
    `$STATE_DIR/claude-home/projects/-<sanitized-sandbox-cwd>/`. Read by
    `SessionReader`.
  - **Chat sessions** — DB-backed (`executions` table grouped by
    `trigger_id` / Slack thread). Read by `ChatSessionReader`; messages
    resolved to the single jsonl owned by `messaging_sessions.agent_session_id`.
- **Permission profiles** (`src/engine/executor.ts`) — each workflow maps to
  a `GitAccessProfile`: `read`, `issues-write`, `review-write`, `repo-write`.
  `runner.ts` picks one per workflow name and `executor.ts` mints a
  downscoped installation token for the sandbox. Only `repo-write` runs see
  the App PEM; everything else uses a pre-minted scoped token (static-token
  mode in mcp-github-app).
- **Approval gates** — phases can declare `approval_gate: post_architect`.
  When hit, the run persists with `status: paused`, a row in
  `workflow_approvals`, and the user can resolve it via GitHub comment
  (`@last-light approve` / `reject`), Slack slash command (`/approve`,
  `/reject`), or the dashboard. Resume logic is in `src/workflows/resume.ts`.

## State directory

Everything persistable lives under `$STATE_DIR` (default `./data`, mount as
a Docker volume in production).

```
data/
  lastlight.db              SQLite — executions, workflow_runs,
                            workflow_approvals, messaging_sessions,
                            messaging_messages, rate_limits, system_status.
  claude-home/              HOME for the Agent SDK inside the harness. Its
                            `projects/` subdir is the source of truth for
                            session jsonls:
    projects/
      -app/                 In-process chat sessions (cwd = /app).
      -home-agent-workspace/  Sandbox sessions (cwd inside the container).
  sandboxes/                Cloned repos per task (one dir per taskId).
  sessions/                 Legacy — unused for Agent SDK jsonls now.
                            Kept for structured stream logs if enabled.
  logs/                     Structured harness logs.
  secrets/app.pem           Mode-600 copy of the GitHub App PEM. Copied
                            here by deploy/entrypoint.sh so sandbox
                            containers can read it via the shared volume
                            (sandbox-entrypoint materializes an
                            agent-readable copy only when ALLOW_APP_PEM=1).
```

## Commands

```bash
# Dev server (webhooks + Slack socket + cron + admin dashboard)
npm run dev              # tsx watch mode
npm run build            # tsc for server
npm run build:dashboard  # vite build for dashboard/
npm start                # compiled JS

# Tests
npx vitest run           # full server suite
cd dashboard && npx tsc -b  # dashboard typecheck

# CLI — thin client that POSTs to a running server
npm run cli -- <github-url>            # default: triage the issue (cheap)
npm run cli -- owner/repo#N            # shorthand
npm run cli -- build owner/repo#N      # explicit full build cycle
npm run cli -- triage owner/repo       # repo-wide scan
npm run cli -- review owner/repo       # repo-wide PR scan
npm run cli -- health owner/repo       # weekly health report

# Local dev with Docker sandbox isolation
./scripts/dev-local.sh                 # sets up secrets + claude-home mount
```

## Environment

Required:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`
- `WEBHOOK_SECRET` — must match the GitHub App webhook secret
- `ANTHROPIC_API_KEY` — or rely on `claude login` (subscription mode)

Models:

- `CLAUDE_MODEL` — default model (sonnet-4-6 if unset)
- `CLAUDE_MODELS` — per-task overrides as JSON, e.g.
  `{"architect":"claude-opus-4-6","triage":"claude-haiku-4-5-20251001"}`.
  Keys match phase names or skill types. `chat` is intentionally NOT
  overridden — Haiku refuses tool calls and creates false "no permission"
  replies.

Runtime:

- `PORT` — webhook listener port (default 8644)
- `STATE_DIR` — persistent state dir (default `./data`)
- `DB_PATH` — override SQLite path
- `CLAUDE_HOME_DIR` — override Agent SDK HOME (default `$STATE_DIR/claude-home`)
- `MCP_CONFIG_PATH` — override generated MCP config path

Admin dashboard:

- `ADMIN_PASSWORD` — if set, login required
- `ADMIN_SECRET` — HMAC secret for session tokens

Slack (optional):

- `SLACK_BOT_TOKEN` (xoxb-…), `SLACK_APP_TOKEN` (xapp-…) — enables the
  messaging connector + chat skill
- `SLACK_DELIVERY_CHANNEL` — channel id for cron reports
- `SLACK_ALLOWED_USERS` — comma-separated user ids allowlist
- `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`,
  `SLACK_OAUTH_REDIRECT_URI` — enables "Login with Slack" on the dashboard
  (OIDC via arctic, uses `openid.connect.userInfo`)
- `SLACK_ALLOWED_WORKSPACE` — restrict OAuth login to one team_id / domain

## Sub-folder docs

- `src/workflows/CLAUDE.md` — runner internals: phase types, linear vs DAG,
  loop iteration naming (`reviewer_2`, `reviewer_fix_1`), approval gates,
  resume semantics, taskId scoping, template rendering.
