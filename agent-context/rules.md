# Operational Rules

## GitHub-First Coordination

**All work is coordinated through GitHub issues.** Regardless of where a request originates, GitHub is the single source of truth.

- **If an issue already exists:** Use it. Post context, progress, and results as comments.
- **If no issue exists:** Create one in the appropriate repo before starting work.
- **Every phase of work** posts a brief update to the issue: architect analysis summary, executor progress, reviewer verdict, PR link.

## Git Authentication

At the start of any task involving git operations:
1. Call the `clone_repo` MCP tool — this clones with authentication, sets up credential helper, and configures bot identity in one step.
2. `git push`, `git pull`, `git fetch` all work transparently after cloning.
3. If auth fails after ~1 hour, call `refresh_git_auth` with the repo path to get a fresh token.

## Managed Repositories

- cliftonc/drizzle-cube
- cliftonc/drizby
- cliftonc/lastlight

**After cloning, always read the repo's own docs first:**
1. Check for `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` in the repo root
2. Read them before doing any analysis, testing, or implementation
3. These files contain project-specific commands, conventions, and architecture notes

## Review Guidelines

When reviewing pull requests, follow this priority order:

### Critical (must fix before merge)
- Security vulnerabilities (injection, auth bypass, secret exposure)
- Data loss risks
- Breaking API changes without migration path
- Missing error handling on external calls

### Important (should fix)
- Missing or inadequate tests for new functionality
- Performance regressions (N+1 queries, unbounded loops, large allocations)
- Incorrect or missing type annotations on public APIs
- Race conditions or concurrency issues

### Suggestions (nice to have)
- Code clarity improvements, naming, deduplication, documentation

### Nits (optional)
- Style preferences not caught by linters, minor formatting

## Issue Triage Rules

1. **Bug reports**: Verify reproduction steps exist. Label `bug`. If missing info, add `needs-info` and comment asking for details.
2. **Feature requests**: Label `enhancement`. Check for duplicates.
3. **Questions**: Answer if possible, or label `question` and point to docs.
4. **Stale issues**: Issues with `needs-info` and no response for 14 days get a gentle reminder. 30 days → close with explanation.

## Labels

Ensure these labels exist on managed repos:
- `bug`, `enhancement`, `question`, `documentation`
- `good first issue`, `help wanted`
- `needs-info`, `needs-review`, `stale`
- `critical`, `breaking-change`
- Priority: `p0-critical`, `p1-high`, `p2-medium`, `p3-low`
