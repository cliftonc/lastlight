# Last Light — Development Guide

Last Light is a GitHub repository maintenance agent. It receives webhook events and runs AI agents to triage issues, review PRs, and implement fixes via an Architect→Executor→Reviewer cycle.

## Architecture

- `src/` — TypeScript harness: connectors, event router, agent executor, cron, state
- `src/connectors/` — Extensible connector layer (GitHub webhooks, future Slack/Discord)
- `src/engine/` — Core: event routing, Agent SDK executor, subagent definitions, orchestrator
- `src/worktree/` — Git worktree manager for per-task isolation
- `src/cron/` — Scheduled jobs (triage, PR review, health reports)
- `src/state/` — SQLite for execution tracking
- `mcp-github-app/` — MCP server providing 28+ GitHub tools via Octokit + GitHub App auth
- `skills/` — SKILL.md files consumed by the agent (issue-triage, pr-review, github-orchestrator, etc.)
- `agent-context/` — System prompts injected into Agent SDK sessions (personality, rules, guidelines)

## Key Concepts

- **Connector interface** (`src/connectors/types.ts`): All event sources emit `EventEnvelope` — the engine never sees raw platform payloads
- **Deterministic routing** (`src/engine/router.ts`): Events are routed to skills by code, not by LLM
- **Agent SDK** (`@anthropic-ai/claude-agent-sdk`): `query()` runs agents with built-in tools, MCP servers, and named subagents
- **Worktrees**: Each build task gets an isolated git worktree; the Docker container is the sandbox boundary

## Commands

```bash
# Server (webhook listener + cron)
npm run dev          # Run with tsx (development)
npm run build        # Compile TypeScript
npm start            # Run compiled JS

# Local dev CLI — paste a GitHub URL to trigger a build cycle
npm run cli -- https://github.com/cliftonc/drizzle-cube/issues/42
npm run cli -- cliftonc/drizzle-cube#42

# Skill shortcuts
npm run cli -- triage cliftonc/drizzle-cube
npm run cli -- review cliftonc/drizzle-cube
npm run cli -- health cliftonc/drizzle-cube
```

## State Directory

All persistent state lives under `STATE_DIR` (default: `./data`). Mount this as a Docker volume for durability and monitoring access.

```
data/
  lastlight.db        # SQLite: execution log, rate limits
  sessions/           # Agent SDK JSONL session files (full audit trail)
  logs/               # Structured logs
  sandboxes/          # Cloned repos per task (e.g., drizzle-cube-592/)
```

## Environment Variables

- `WEBHOOK_SECRET` — GitHub webhook signature secret
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID` — GitHub App auth
- `ANTHROPIC_API_KEY` — Claude API key
- `CLAUDE_MODEL` — Model to use (default: claude-sonnet-4-6)
- `PORT` — Webhook listener port (default: 8644)
- `STATE_DIR` — Persistent state directory (default: `./data`). Mount as Docker volume.
- `DB_PATH` — SQLite path override (default: `$STATE_DIR/lastlight.db`)
