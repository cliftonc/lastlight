---
name: github-orchestrator
description: >
  Central coordinator for all GitHub work — routes events to the right action
  (triage, review, build) and orchestrates the Architect→Executor→Reviewer cycle
  for build requests. All work is tracked via GitHub issues.
version: 3.0.0
tags: [github, orchestrator, webhook, build-cycle, coordination]
related_skills: [architect, pr-review, issue-triage, repo-health]
---

# GitHub Orchestrator

The build cycle is orchestrated programmatically by the harness (`src/engine/orchestrator.ts`).
This skill file provides guidelines for each phase that the agent should follow.

## Git Authentication

Git is pre-configured by the harness. Clone, push, pull, and fetch work natively:

```bash
git clone https://github.com/owner/repo.git
```

If auth fails after ~1 hour, call `refresh_git_auth` MCP tool with the repo path.

## Phase Guidelines

### Phase 0: Context Assembly
- Read issue context via MCP tools (get_issue, list_issue_comments)
- Clone the repo via `clone_repo` MCP tool
- Check for existing branch: `git branch -a --list '*lastlight/{issue-number}*'`
- If branch exists, read `.lastlight/issue-{N}/status.md` to resume
- Read repo docs: CLAUDE.md, AGENTS.md, CONTRIBUTING.md
- Assemble context snapshot: task, desired outcome, known facts, constraints, unknowns, touchpoints

### Phase 1: Architect
- Create branch: `git checkout -b lastlight/{issue-number}-{slug}`
- Analyze codebase (read-only — never edit files)
- Reference specific locations as `file:line`
- Write plan to `.lastlight/issue-{N}/architect-plan.md`
- Plan must include: problem statement, files to modify, implementation steps, risks, test strategy, complexity estimate
- Commit and push the plan

### Phase 2: Executor
- Read the architect plan from `.lastlight/issue-{N}/architect-plan.md`
- Follow TDD: write failing test first, then implement, then verify
- Run tests and include fresh verification output
- Write summary to `.lastlight/issue-{N}/executor-summary.md`
- Commit with intent-first messages + Tested/Scope-risk trailers

### Phase 3: Reviewer
- Independent context — no shared state with executor
- Review ONLY changed files: `git diff main...HEAD`
- Read architect-plan.md and executor-summary.md for context
- Run tests independently
- Write verdict to `.lastlight/issue-{N}/reviewer-verdict.md`
- End with exactly: APPROVED or REQUEST_CHANGES

### Phase 4: Fix Loop (max 2 cycles)
- Fix ONLY issues from reviewer-verdict.md
- APPEND to executor-summary.md (never overwrite)
- Re-run reviewer after each fix

### Phase 5: Create PR
- Use `create_pull_request` MCP tool
- Link to tracking issue with "Closes #N"
- Include links to plan, summary, and verdict files on the branch
- Post PR link as comment on the tracking issue

## Status File: `.lastlight/issue-{N}/status.md`

```markdown
# Orchestrator Status: #{issue-number}

| Field | Value |
|-------|-------|
| issue | {owner}/{repo}#{issue-number} |
| branch | lastlight/{issue-number}-{slug} |
| current_phase | {phase_0 / architect / executor / reviewer / fix_loop_N / complete} |
| last_updated | {ISO timestamp} |
| fix_cycles | {0, 1, 2} |
| pr_number | {number or empty} |

## Phase Log
| Phase | Status | Timestamp | Notes |
|-------|--------|-----------|-------|
```

Update after each phase transition. Commit + push alongside phase artifacts.

## Tool Usage

- **GitHub API** (comments, labels, PRs, issues): use MCP tools
- **Reading repo files**: clone once, read locally. Never use get_file_contents for bulk reads.
- **Git auth**: pre-configured by harness. Just `git clone`. Call `refresh_git_auth` if auth expires.
- **Suppress noise**: `git clone --quiet`, `git push --quiet`, `CI=true npm install`

## Always Ignore

- Actions: deleted, edited, labeled, unlabeled, assigned, closed, synchronize
- Bot senders (sender.type === "Bot" or login ending in "[bot]")
- Events where sender matches the bot's own login
