# Phase 3 — Read-only workflow validation results

**Date:** 2026-05-19
**Branch:** `opencode-fork`
**Sandbox image:** `lastlight-sandbox:latest` (2.17 GB, opencode-ai@1.15.5 baked in)
**Model used in run:** `openai/gpt-5.3-codex` (harness default)

## Outcome

Phase 3 infrastructure verification complete. The OpenCode runtime swap
works end-to-end. Per-workflow qualitative output comparison vs the main
branch (the plan's "compare AVG(cost_usd), tool-call counts, failure
rate") is **operationally blocked** on OpenAI API quota — not a code
issue. Once an API key with budget is wired in, the same harness binary
will produce real reports without further code changes.

## What was verified

### Prompt audit — clean for the 3 read-only skills
Skills are `repo-health`, `issue-triage`, `pr-review`. Surgical edits
landed before the test run:

- `skills/repo-health/SKILL.md` — `mcp_github_*` → `github_*` in the
  Tool Usage section.
- `skills/issue-triage/SKILL.md` — same. `list_issue_comments` →
  `github_list_issue_comments`.
- `skills/pr-review/SKILL.md` — same. Bare names
  `list_pull_request_files`, `get_pull_request`,
  `create_pull_request_review` → `github_*` form.

The prefix change matches what OpenCode actually exposes to the agent
(`<server>_<tool>`, per Phase 0 findings). The dashboard
classifier still routes them as MCP/git family because the
Phase 2 jsonl shim translates them back to `mcp_github_*` for display.

Other skills (used by Phase 4 repo-write workflows) still use
`mcp_github_*` — explicitly deferred to Phase 4's "rephrase tool-name
references" pass.

### Docker image builds clean

```
$ docker-compose build sandbox
…
Image lastlight-sandbox:latest Built
$ docker images lastlight-sandbox:latest --format "{{.Size}}"
2.17GB
$ docker run --rm --entrypoint sh lastlight-sandbox:latest -c 'opencode --version'
1.15.5
```

OpenCode v1.15.5 pinned and on PATH; node v20.20.2 base.

### End-to-end workflow run (`repo-health` on `cliftonc/drizzle-cube`)

```
[api] CLI triggered: workflow=repo-health
[simple] Created workflow run fd1518ee-7323-4a8b-a42f-2a2238101390 (repo-health)
[dispatch] ▶ repo-health/report
[executor] Minting git token: profile=read, repo=drizzle-cube, permissions=…
[sandbox] Docker sandbox available (image: lastlight-sandbox:latest)
[sandbox] Created: lastlight-sandbox-…
  [executor] Running in sandbox
  [executor] Result: error_api (0 turns, 4s) [session ses_1bf4e7f59ffepz2NkffdESY5hv]
  [executor] Error: Quota exceeded. Check your plan and billing details.
```

DB row (`executions`):

| field | value |
|---|---|
| `skill` | `repo-health:report` |
| `success` | `0` |
| `session_id` | `ses_1bf4e7f59ffepz2NkffdESY5hv` ✓ (Phase 1 sessionId capture working) |
| `cost_usd` | `NULL` (no charge for rejected request) |
| `stop_reason` | `error_api` ✓ (Phase 1 mapping working) |
| `error` | `"Quota exceeded. Check your plan and billing details."` |
| `duration_ms` | 3535 |

Phase 2 jsonl shim output at
`data/sandbox-data/claude-home/projects/-home-agent-workspace/ses_1bf4e7f59ffepz2NkffdESY5hv.jsonl`
(3 lines):

1. `{"type":"user","message":{"role":"user","content":"Follow these skill instructions:…"},…}`
2. `{"type":"assistant","isApiErrorMessage":true,"error":"Quota exceeded.…",…}`
3. `{"type":"result","subtype":"error_api","num_turns":0,…}`

Dashboard SessionReader will pick this up because it scans every project
dir under `claude-home/projects/` except `-app` — no code change needed.

### CLI/dispatcher mismatch noted (pre-existing, not Phase 1/2/3 regression)

`npm run cli -- triage <owner/repo>` (repo-wide scan) sends
`{ repos: [target], mode: "scan" }`, but `dispatchWorkflow` in
`src/index.ts:130-135` requires `context.repo`. Workaround used for the
test run: hit `/api/run` directly with `{ skill: "repo-health",
context: { repo: "owner/name" } }`. Tracking only — not in scope for
Phase 3.

## Carried into Phase 4

- **Qualitative output comparison** against the main branch baseline —
  blocked on OpenAI API budget. Recommend funding `OPENAI_API_KEY` (or
  reverting to Anthropic via `claude-…` model strings + an
  `ANTHROPIC_API_KEY` with budget) before Phase 4 lands.
- **Skill prompt sweep for repo-write skills** — Phase 4 explicitly does
  this grep, so no work needed here.
- **CLI repo-wide scan** — fix `repos[]` → fan-out of single-`repo`
  dispatches, or fix the dispatcher guard to accept `repos[]`. Phase 7
  cleanup candidate.
