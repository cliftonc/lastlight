---
name: maintenance-review
description: Weekly low-noise continuous maintenance dashboard for recently changed repository files
version: 1.0.0
metadata:
  hermes:
    tags: [github, maintenance, health]
    category: maintenance
---

# Maintenance Review Skill

Maintain one long-lived **Maintenance dashboard** issue for a repository. The dashboard contains a small, current backlog of actionable maintenance suggestions derived from recently changed human-authored files.

This is intentionally **not** a whole-repo critique. It should prefer zero suggestions over speculative advice, avoid noisy comments, and never start broad migrations or architecture redesigns.

## Context

- `context.repo` — `owner/name` of the repo to scan. This skill is repo-scoped and expects one repo from cron fan-out or a dashboard run.
- `context.mode` — normally `scan`.
- `context.issueDir` — optional directory for writing the run summary artifact.

## Procedure

### 1. Ensure labels exist

Call `github_create_label` for each label below. Treat 422/already-exists responses as success.

| Label | Color | Purpose |
|-------|-------|---------|
| `maintenance` | `0366d6` | General maintenance suggestions |
| `maintenance-scan` | `fbca04` | The long-lived maintenance dashboard issue |

### 2. Discover or create the dashboard issue

1. Search open issues in `context.repo` labelled `maintenance-scan`.
2. From the results, find issues whose body contains the marker:
   `<!-- lastlight-maintenance-version: 1 -->`
3. If exactly one matching issue exists, reuse it.
4. If multiple matching open issues exist, reuse the oldest issue number and record the duplicate issue numbers in the run summary artifact. Do not close duplicates.
5. If no matching issue exists, create exactly one issue:
   - Title: `Maintenance dashboard`
   - Labels: `maintenance`, `maintenance-scan`
   - Body: a minimal dashboard body using the grammar in § Dashboard issue format, including all metadata markers.

Do not create a per-run issue. Unlike the security-review skill, this skill updates one stable dashboard.

### 3. Read prior metadata markers

The dashboard body is the source of truth for scan state. Parse these stable HTML comments:

```markdown
<!-- lastlight-maintenance-version: 1 -->
<!-- lastlight-maintenance-ts: ISO_TIMESTAMP -->
<!-- lastlight-maintenance-anchor: BRANCH@SHORTSHA -->
<!-- lastlight-maintenance-terminal-fps: fp1,fp2,... -->
```

Rules:

- If `lastlight-maintenance-ts` is missing or malformed, use `now - 30 days` as the bootstrap floor.
- If `lastlight-maintenance-anchor` is missing or unusable, continue using the timestamp fallback.
- Treat the terminal fingerprint archive as a comma-separated list of lowercase hex strings.
- Bound the archive to the most recent 500 fingerprints when writing the issue body.
- Always update the timestamp and anchor markers after a successful run, including no-change and no-suggestion runs.

### 4. Clone and compute the delta changeset

1. Clone the target repo with `github_clone_repo`.
2. Determine the default branch and current short SHA. The new anchor is `BRANCH@SHORTSHA`.
3. Optionally read `MAINTENANCE.md` from the repo root. Treat it as human-readable guidance only: preferred patterns, avoid-list, hot paths, and “do not suggest” constraints. Do not implement or require `.lastlight/maintenance.yaml` in v1.
4. List commits since the prior scan timestamp:

   ```bash
   git log --since="${priorScanTs}" --pretty=format:'%H|%an|%ae|%s'
   ```

5. Drop a commit when any of these dependency/bot heuristics match:
   - Author email matches `*[bot]@users.noreply.github.com` and author name is `dependabot[bot]`, `renovate[bot]`, or `github-actions[bot]`.
   - Commit subject starts with `chore(deps)`, `chore(deps-dev)`, `build(deps)`, `build(deps-dev)`, or `fix(deps)`.
6. For surviving commits, accumulate changed files with:

   ```bash
   git diff-tree --no-commit-id --name-only -r ${sha}
   ```

7. Drop lockfile-only noise: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `Gemfile.lock`, `poetry.lock`, `uv.lock`, `Cargo.lock`, `composer.lock`.
8. Build `commitsReviewed` from surviving commits with `{ shortSha, subject }`.
9. If no relevant human commits or changed files remain, update the dashboard metadata/status text only, write the run summary artifact, and return without adding suggestions.

### 5. Parse existing dashboard rows and dedupe state

Parse all visible rows matching the grammar in § Dashboard issue format:

- Unchecked rows are open suggestions and should remain visible and stable whenever possible.
- Checked rows are terminal.
- Rows struck through with `→ #123` are broken out into their own issue and terminal.
- Archive fingerprints from checked and broken-out rows before weekly cleanup.
- Also parse fingerprints in `lastlight-maintenance-terminal-fps`.

A fingerprint is a lowercase hex SHA-1 over:

```text
category:title-or-rule:file:nearby-normalized-context
```

Equivalent inputs are acceptable, but never include the visible item number. Normalize whitespace and casing in the nearby context enough that small line shifts do not create duplicates.

Do not resurface a suggestion if its fingerprint is:

- already present in an unchecked open row,
- checked,
- broken out with `→ #123`, or
- present in the terminal fingerprint archive.

### 6. Suggestion scope and caps

Generate at most **5 new suggestions per run**. Add **no** new rows when approximately **50 unchecked rows** already exist.

V1 categories only:

- `tests`
- `docs`
- `cleanup` / `dead-code`
- `simplification`
- `ci` only when CI/tooling files were recently touched

Each suggestion must be:

- local and actionable,
- tied to a recently changed human-authored file,
- backed by concrete evidence from the changed file or related tests/docs,
- small enough for a maintainer to handle independently, and
- compatible with `MAINTENANCE.md` guidance if present.

Explicitly forbidden in v1:

- large migrations,
- architecture redesigns,
- dependency upgrade programs,
- unrelated full-repo audits,
- speculative “consider improving” advice without a nearby code example,
- suggestions based solely on untouched files.

Zero suggestions is a valid successful result.

### 7. Weekly cleanup and body rewrite

On every successful run:

1. Archive fingerprints for visible checked and broken-out rows.
2. Remove visible checked and broken-out rows from the dashboard body.
3. Preserve human-maintained unchecked rows and their `<details>` blocks as much as possible.
4. Merge in up to 5 new deduped suggestions, respecting the 50-open-row cap.
5. Renumber visible open rows from top to bottom after the rewrite.
6. Keep sections in the canonical order from § Dashboard issue format.
7. Keep the hidden terminal archive bounded to 500 fingerprints.
8. Update the scan summary line and all metadata markers.

Avoid noisy issue comments. The issue body update is the notification.

### 8. Dashboard issue format

The body is machine-readable Markdown. Keep this grammar stable for future feedback handling.

Header:

```markdown
# Maintenance dashboard

Low-noise maintenance suggestions from recent human-authored changes. Items are intentionally small, local, and safe to ignore or break out into issues.

Last scan: YYYY-MM-DDTHH:MM:SSZ — reviewed N human commits / M changed files; added K suggestions; open O.

<!-- lastlight-maintenance-version: 1 -->
<!-- lastlight-maintenance-ts: ISO_TIMESTAMP -->
<!-- lastlight-maintenance-anchor: BRANCH@SHORTSHA -->

## Open suggestions

### Tests
### Docs
### Cleanup / dead code
### Simplification
### CI / tooling

<!-- lastlight-maintenance-terminal-fps: fp1,fp2,... -->
```

Canonical row forms:

```markdown
- [ ] <!-- item:N fp:FINGERPRINT cat:CATEGORY --> **TITLE** — `FILE:LINE`
- [x] <!-- item:N fp:FINGERPRINT cat:CATEGORY --> **TITLE** — `FILE:LINE`
- [x] <!-- item:N fp:FINGERPRINT cat:CATEGORY --> ~~**TITLE** — `FILE:LINE`~~ → #123
```

Each row must be immediately followed by a details block:

```markdown
  <details>
  <summary>Evidence and suggested next step</summary>

  **Evidence:** Concrete changed-file evidence, with commit/file/line references where possible.

  **Why it matters:** Short explanation of maintainability impact.

  **Suggested next step:** One small action a maintainer or contributor can take.

  </details>
```

Category values in row metadata should be stable slugs: `tests`, `docs`, `cleanup`, `dead-code`, `simplification`, or `ci`.

### 9. Write the run summary artifact

Write `.lastlight/maintenance-summary.md`, or `{issueDir}/maintenance-summary.md` when `context.issueDir` is provided.

Use this structure:

```markdown
# Maintenance Scan Summary — {repo}

**Date**: {YYYY-MM-DDTHH:MM:SSZ}
**Dashboard issue**: #{issueNumber}
**Prior anchor**: {priorScanTs} / {priorAnchor or "none"}
**New anchor**: {branch}@{shortSha}
**Commits reviewed**: {N} (after filtering bots/dependency churn)
**Changed files**: {M}
**Existing open suggestions**: {openCountBefore}
**Terminal fingerprints archived**: {archivedCount}
**New suggestions added**: {newSuggestionCount}
**Open suggestions after update**: {openCountAfter}
**No-change reason**: {reason or "n/a"}
```

If multiple matching dashboard issues were found, include a note naming the reused issue and duplicate issue numbers.

### 10. Verification and final response

Report success only after one of these happened:

- the dashboard issue was created,
- the dashboard issue body was updated, or
- an explicit no-op update completed with refreshed metadata/status text and a run summary artifact.

For cron/no-change/no-suggestion cases, do not add issue comments and do not emit a noisy Slack-style summary. Prefer returning the run summary contents as the final response when an explicit response is required.
