You just fixed and pushed a dependency-update PR. Now assess how big the change
was and decide whether it is safe to auto-merge.

You are inside the {{repo}} repo at branch `{{branch}}` (cwd = repo root).

CONTEXT:
- PR #{{prNumber}}: {{issueTitle}}
- Repository: {{owner}}/{{repo}}

STEP 1 — Inspect the change.
Review the FULL diff of this PR against its base branch — the dependency bump
plus any fix you pushed. Use `git diff origin/{{baseBranch}}...HEAD` (or the
`github_get_pull_request_diff` tool). Apply the **code-review** skill's rubric.

STEP 2 — Classify the change, conservatively.
Call it **TRIVIAL** only if ALL of these hold:
- it is limited to dependency metadata (lockfile / manifest version bumps),
  type-only edits, comments, or mechanical rename/signature updates, AND
- there is NO change to runtime logic, control flow, or behaviour, AND
- nothing security-sensitive (auth, crypto, deserialization, network, file I/O)
  changed in a meaningful way.
If you are unsure, or the change touches application logic, treat it as
**FUNCTIONAL**. When in doubt, do NOT auto-merge.

STEP 2b — Record the verdict as a label (state machine).
First ensure the label vocabulary exists in ONE idempotent `github_ensure_labels`
call (`{ owner: "{{owner}}", repo: "{{repo}}", labels: [...] }`) — it lists once
and creates only the missing ones, so it never errors on labels that exist:
- `dependency-trivial` — color `0e8a16` — "Trivial & safe dependency update (auto-merge path)."
- `dependency-functional` — color `fbca04` — "Dependency update has functional impact — needs human review."
- `requires-human` — color `b60205` — "Last Light can't proceed automatically; a maintainer must handle it."
If `github_ensure_labels` is denied, fall back to using only labels that already
exist and skip the rest. Then apply exactly the labels for your verdict via
`github_add_labels` and clear the superseded ones with `github_remove_label` (only
ever touch these three labels — never remove one outside this vocabulary):
- **TRIVIAL** → add `dependency-trivial`; remove `dependency-functional` and
  `requires-human` if present. (Your fix succeeded and is trivial, so this clears
  any `requires-human` a prior failed fix left on the PR.)
- **FUNCTIONAL** → add `dependency-functional` and `requires-human`; remove
  `dependency-trivial` if present.

STEP 3 — Act on the classification.
- If **TRIVIAL**: enable auto-merge by calling the `github_enable_auto_merge`
  tool with `{ owner: "{{owner}}", repo: "{{repo}}", pull_number: {{prNumber}},
  merge_method: "squash" }`. This does NOT merge immediately — GitHub merges the
  PR only once the re-run checks pass. If the tool returns `{ ok: false }` (the
  repository does not allow auto-merge), post a brief comment on the PR saying the
  fix looks trivial but auto-merge is disabled, so a maintainer should merge it,
  using `github_add_issue_comment`.
- If **FUNCTIONAL**: do NOT merge. Post a short comment on the PR (via
  `github_add_issue_comment`) summarising what changed and why it warrants a human
  review before merging.

OUTPUT: State your verdict (TRIVIAL or FUNCTIONAL), a one-line justification, and
whether you enabled auto-merge or left the PR for a human.
