---
name: pr-comment
description: Answer a maintainer's question about an open PR with concrete, code-cited evidence
version: 1.0.0
tags: [github, pr, comments, qa]
---

# PR Comment Skill

## When to Use

When a maintainer @mentions last-light on a pull request with a question or
discussion (NOT a request to write code). Examples:

- "@last-light does this PR consider X?"
- "@last-light why did we change Y here?"
- "@last-light is the new function thread-safe?"
- "@last-light any regression risk for the existing callers?"

This is the PR-side counterpart to `issue-comment`. Use the issue-comment skill
for general issue questions; use this one for questions tied to the diff.

## Procedure

### 1. Read the PR and the question

- `get_pull_request({ owner, repo, pull_number })` → title, body, base, head
- `get_pull_request_diff({ owner, repo, pull_number })` → the actual diff
- `list_pull_request_files({ owner, repo, pull_number })` → file list with
  `additions`/`deletions` per file (helps you decide what to read in full)

The triggering comment is in `context.commentBody`. Read it carefully —
the maintainer's question is the entire job. Do not answer a different
question, do not generalise to "review the PR" (that's the `pr-review` skill).

### 2. Investigate the question with the diff in hand

You may read FILES IN FULL when the diff alone doesn't answer the question
— a good answer about thread-safety, regression risk, or call-site impact
needs the surrounding code, not just the patch hunk.

Practical caps:

- Up to **8 file reads** total per invocation.
- For "does the PR consider X?" questions: also check whether tests cover X
  by reading the relevant test files in the diff.
- For "regression risk" questions: search for callers of any functions whose
  signature or behaviour changed (`search_code` is your friend).
- Do not clone the repo unless a single-question answer genuinely needs
  cross-file traces no MCP tool can provide. Most don't.

### 3. Reply with one comment

Use `add_issue_comment` (PRs accept issue comments at this endpoint).

Keep the reply tight:

- **Lead with the answer.** Yes / no / it depends — don't bury it.
- **Cite specific lines** in `path:line` form — these become clickable in the
  GitHub UI.
- 3–8 sentences typical; one short paragraph or a bulleted list. No headings.
- If the question is unanswerable from the PR alone, say so and ask for the
  specific information you'd need.

### 4. Do NOT

- Do NOT post a full review (no `create_pull_request_review` calls — that's
  the pr-review skill's job and it would conflict with the blocking check).
- Do NOT modify code, push commits, or add labels (no write tools beyond the
  one comment).
- Do NOT answer a different question than the one asked, even if you spot
  something interesting in the diff. Note it in one trailing sentence at most.
- Do NOT exceed the 8-file-read cap. If the question genuinely requires a
  full audit, say so and recommend `@last-light` (which routes to pr-review).

## Tool Usage

All GitHub operations via `mcp__github_*` MCP tools. Never `gh` CLI, `curl`,
or raw HTTP.

## Example shape

> Yes, it does — `src/foo.ts:42` checks `X` before calling `bar()`, and
> `tests/foo.test.ts:118` asserts the rejection path. The only place X
> isn't validated is the legacy `barLegacy` exported from `src/foo.ts:67`,
> which this PR doesn't touch — worth a separate issue if you want it
> covered.
