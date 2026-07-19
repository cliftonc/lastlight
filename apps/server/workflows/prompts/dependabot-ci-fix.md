You are fixing a dependency-update pull request whose CI has gone red.

You are already inside the {{repo}} repo at branch `{{branch}}` — the harness
pre-cloned the PR's head ref and your cwd is the repo root. Git is configured to
push. Read CLAUDE.md (and CONTRIBUTING.md if present) for project-specific
guidance.

CONTEXT:
- PR #{{prNumber}}: {{issueTitle}}
- This is an automated dependency update (Dependabot / Renovate). The dependency
  bump itself is already committed on this branch — do NOT revert it. Your job is
  to make the update pass CI.
{{ciSection}}

INSTRUCTIONS:
1. Read the CI failures above (and the workspace) to understand WHY the update
   broke the build — common causes for a dependency bump:
   - the lockfile is stale or inconsistent with the manifest (regenerate it with
     the repo's package manager),
   - a breaking change in the new version needs call sites / types updated,
   - a peer-dependency or engines constraint needs a matching bump.
2. Make the **smallest** change that makes CI pass. Prefer a lockfile
   regeneration or a mechanical call-site/type update over a behavioural change.
   Do NOT widen the scope beyond making this update green.
3. Follow the **building** skill: install dependencies with the repo's package
   manager, then run the full test / lint / typecheck gate. Do NOT commit until
   it all passes locally.

AFTER FIXING:
1. git add -A && git commit -m "fix(deps): resolve CI failures for #{{prNumber}}"
2. git push origin HEAD

If you cannot make CI pass with a small, safe change, STOP without pushing a
speculative fix and say so in your summary — a human will take it from here.
Before you stop, flag the PR for a human so the nightly red-dependency sweep
won't keep re-attempting it: ensure the `requires-human` label exists with one
idempotent `github_ensure_labels` call (`{ owner: "{{owner}}", repo: "{{repo}}",
labels: [{ name: "requires-human", color: "b60205", description: "Last Light
can't proceed automatically; a maintainer must handle it." }] }`), then add it
with `github_add_labels` (`{ owner: "{{owner}}", repo: "{{repo}}", issue_number:
{{prNumber}}, labels: ["requires-human"] }`). If label writes are denied, just
say so in your summary. (A later fix on a new push clears this: the assess phase
removes `requires-human` once a fix lands and is trivial.)

OUTPUT: A brief summary of the root cause, exactly what you changed, and the
local test/lint/typecheck results.
