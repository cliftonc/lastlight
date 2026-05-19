# Phase 4 — Repo-write workflow validation

**Date:** 2026-05-19
**Branch:** `opencode-fork`

## Outcome

Phase 4 **prep complete**; end-to-end repo-write validation
(`build`, `pr-fix`, `security-feedback`, approval-gate flow) deferred
on the same OpenAI quota blocker as Phase 3 — not a code issue.

## Pre-flight items the plan called out

### 1. Sweep skills + prompts for Claude-Code tool-name dependencies

**Done.** Two passes:

**(a) `mcp_github_*` → `github_*`** across 5 SKILL files used by the
repo-write workflows:

- `skills/software-development/assure-guardrails/SKILL.md`
- `skills/security-feedback/SKILL.md`
- `skills/github/github-pr-workflow/SKILL.md`
- `skills/issue-comment/SKILL.md`
- `skills/security-review/SKILL.md`

Plus `workflows/prompts/explore-publish.md` (the `create_issue_comment`
reference, corrected to `github_add_issue_comment` — the actual MCP
tool name, as listed in `mcp-github-app/src/index.js`).

`skills/mcp/native-mcp/SKILL.md` was intentionally left alone — it
documents the generic Claude MCP naming convention as teaching
material, not as a tool-call instruction to the agent.

**(b) Bare MCP tool names prefixed with `github_`** — wherever a
SKILL.md said e.g. "use `create_pull_request`" or "call
`refresh_git_auth`", changed to `github_create_pull_request` /
`github_refresh_git_auth` etc. Files touched:

- `skills/github-orchestrator/SKILL.md`
- `skills/github/github-auth/SKILL.md`
- `skills/github/github-pr-workflow/SKILL.md`
- `skills/pr-comment/SKILL.md`
- `agent-context/rules.md`

Final greps return clean:

```
$ grep -rEn 'mcp_github_' skills/ workflows/ agent-context/
skills/mcp/native-mcp/SKILL.md:127:- Server `github`, tool `list-issues` → `mcp_github_list_issues`
skills/mcp/native-mcp/SKILL.md:282:Registers tools like `mcp_github_list_issues`, ...
   (^ documentation about the MCP convention — intentional)
$ grep -rEn '`(add_issue_comment|...|update_issue)`' skills/ workflows/ agent-context/ | grep -v 'github_'
(no matches)
```

**(c) Claude-Code built-in tool names** (`Bash`, `MultiEdit`,
`TodoWrite`, `WebSearch`, `WebFetch`, etc.) **not referenced anywhere**
in skills/, workflows/prompts/, or agent-context/. Earlier grep hits
were English verbs ("Read the file", "Write a test"), which are
tool-agnostic. Nothing to rephrase.

### 2. Confirm OpenCode permission flag for non-interactive mode

`opencode run --help` shows
`--dangerously-skip-permissions  auto-approve permissions that are not
explicitly denied`. `src/sandbox/docker.ts:177-182` already passes this
flag; matches the Phase 0 plan. No change.

### 3. Verify sandbox timeout

`src/sandbox/docker.ts:175` — default 1800s (30 min) **per phase**. Each
phase in the build cycle (architect / executor / reviewer / fix loop)
is a fresh sandbox invocation, so a multi-phase workflow gets 30 min ×
N. No change needed.

## End-to-end validation — deferred

The plan's verification list:

1. Full `build` workflow on a test issue end-to-end.
2. Full `pr-fix` cycle with a reviewer-requested change.
3. Approval-gate flow: trigger `build`, pause at `post_architect`,
   approve via `@last-light approve`, verify resume.

All three are blocked on the same OpenAI quota issue from Phase 3 —
the executor short-circuits with `error_api: Quota exceeded` before
any tool call lands. The runtime swap itself is verified working end
to end (see Phase 3 results — sessionID captured, shim wrote the
jsonl, DB row populated). Once the API key has budget, these three
runs should "just work" without further code changes; the
approval-gate logic in `src/workflows/resume.ts` is runtime-agnostic
(operates on `ExecutionResult` and DB rows, not on agent internals).

## Carried into Phase 5

- Run the three repo-write validations above once budget is available.
  No expected code changes unless qualitative output reveals model
  drift on the OpenCode runtime.
