# Architect plan — issue #1 Continuous Pressure Job

## Problem Statement

Last Light already has repo-scoped health/security workflows, but the only weekly examples are `repo-health` and `security-review`; there is no maintenance workflow or skill alongside them (`workflows/repo-health.yaml:1`, `workflows/security-review.yaml:1`). Cron wiring is generic and loads `workflows/cron-*.yaml`, then injects `MANAGED_REPOS` into each job context (`src/cron/jobs.ts:9`, `src/cron/jobs.ts:33`), while fan-out converts `repos[]` into one `repo` per sandbox run (`src/cron/fanout.ts:32`, `src/cron/fanout.ts:50`). The security skill already documents the closest reusable patterns for delta-based scans, bot/dependency filtering, labels, fingerprints, issue grammar, and run artifacts (`skills/security-review/SKILL.md:17`, `skills/security-review/SKILL.md:30`, `skills/security-review/SKILL.md:41`, `skills/security-review/SKILL.md:96`, `skills/security-review/SKILL.md:209`). To create/update a long-lived dashboard issue, the new workflow also needs write access to issues; today only existing issue-oriented workflows such as `security-review` are mapped to `issues-write` (`src/workflows/runner.ts:140`, `src/workflows/runner.ts:144`).

## Summary of what needs to change

- Add a new single-phase `maintenance-review` health workflow.
- Add a new weekly weekend cron definition that targets `maintenance-review`; existing loader/jobs/fan-out should pick it up without scheduler code changes.
- Add a new `skills/maintenance-review/SKILL.md` procedure that defines the long-lived maintenance dashboard issue, delta scan algorithm, row grammar, dedupe/archive behavior, caps, guardrails, and run artifact.
- Grant `maintenance-review` the `issues-write` GitHub permission profile.
- Add focused tests for workflow YAML parsing, cron YAML parsing, and the permission mapping.
- Do not add CLI/router/Slack/manual triggers or `maintenance-feedback` in v1.

## Files to modify

### `workflows/maintenance-review.yaml` (new)

Create a new health workflow modelled on `workflows/security-review.yaml:1-29` and `workflows/repo-health.yaml:1-15`:

- `kind: health`
- `name: maintenance-review`
- description: weekly low-noise continuous maintenance scan, one repo per invocation, cron/dashboard-run driven.
- one phase:
  - `name: scan`
  - `label: Maintenance scan`
  - `skill: maintenance-review`
  - `model: "{{models.health}}"`
  - `variant: "{{variants.health}}"`

Use the existing health model/variant to avoid introducing new config keys.

### `workflows/cron-maintenance.yaml` (new)

Create a cron workflow alongside `workflows/cron-security.yaml:1-6` and `workflows/cron-health.yaml:1-6`:

- `kind: cron`
- `name: weekly-maintenance-scan`
- `schedule`: choose a weekend UTC slot, e.g. `"0 11 * * 6"` (Saturday 11:00 UTC) to avoid colliding with Monday health/security scans.
- `workflow: maintenance-review`
- `context:` include `mode: scan`.

No changes should be needed in `src/cron/jobs.ts` because it already loads cron YAMLs and merges `repos: MANAGED_REPOS` into context (`src/cron/jobs.ts:21`, `src/cron/jobs.ts:33`). No changes should be needed in `src/cron/fanout.ts` because it already turns `repos[]` into singular `repo` contexts (`src/cron/fanout.ts:42-53`).

### `skills/maintenance-review/SKILL.md` (new)

Create a new skill file. The repo's contributing docs require skills to live at `skills/<name>/SKILL.md` and contain clear procedural sections (`CONTRIBUTING.md:18`, `CONTRIBUTING.md:25`). Base structure on `skills/security-review/SKILL.md`, but adapt it to a long-lived dashboard issue instead of one issue per scan.

Required content:

1. **Context/mission**
   - Repo-scoped skill, expects `context.repo` from cron fan-out or dashboard run.
   - Low-noise weekly maintenance suggestions only; no broad whole-repo critique.

2. **Label setup**
   - Ensure labels with idempotent `github_create_label`, ignoring already-exists errors, mirroring the security label step (`skills/security-review/SKILL.md:41-50`):
     - `maintenance` (`0366d6`)
     - `maintenance-scan` (`fbca04`)

3. **Dashboard issue discovery/creation**
   - Search open issues labelled `maintenance-scan` and body marker `<!-- lastlight-maintenance-version: 1 -->`.
   - Reuse if found; otherwise create exactly one issue titled `Maintenance dashboard` with labels `maintenance`, `maintenance-scan`.
   - This differs from security, which intentionally creates one summary issue per run (`skills/security-review/SKILL.md:161-169`).

4. **Metadata markers**
   - Define stable comments:
     - `<!-- lastlight-maintenance-version: 1 -->`
     - `<!-- lastlight-maintenance-ts: ISO_TIMESTAMP -->`
     - `<!-- lastlight-maintenance-anchor: BRANCH@SHORTSHA -->`
     - hidden terminal fingerprint archive block, bounded to a retention limit such as 500 fingerprints:
       - `<!-- lastlight-maintenance-terminal-fps: fp1,fp2,... -->`
   - Bootstrap missing prior timestamp with `now - 30 days`.
   - Always update markers after a successful run, including no-change/no-suggestion runs.

5. **Delta changeset algorithm**
   - Clone via `github_clone_repo`.
   - Determine default branch and current short SHA for the new anchor.
   - Use prior marker timestamp/anchor; list commits since prior timestamp with `git log --since="${priorScanTs}" --pretty=format:'%H|%an|%ae|%s'` as in the security skill (`skills/security-review/SKILL.md:30-31`).
   - Filter bot/dependency noise using the existing security heuristics (`skills/security-review/SKILL.md:32-36`).
   - Build `changedFiles` from surviving commits only.
   - If no relevant human commits/files remain, update only metadata/status text and write the summary artifact.

6. **Guardrails/config**
   - Optionally read `MAINTENANCE.md` from repo root.
   - Treat it as human-readable guidance: preferred patterns, avoid-list, hot paths, and “do not suggest” constraints.
   - Do not implement `.lastlight/maintenance.yaml` in v1.

7. **Suggestion scope and caps**
   - Generate at most 5 new suggestions per run.
   - Preserve existing unchecked open suggestions.
   - Add no new rows when around 50 unchecked rows already exist.
   - V1 categories only:
     - `tests`
     - `docs`
     - `cleanup` / `dead-code`
     - `simplification`
     - `ci` only when recently touched.
   - Require suggestions to be local, actionable, and related to recently changed human-authored files.
   - Explicitly forbid large migrations, architecture redesigns, dependency upgrade programs, and unrelated full-repo audits.

8. **Fingerprinting and dedupe**
   - Define fingerprint as lowercase hex SHA-1 over `category:title-or-rule:file:nearby-normalized-context` or equivalent; never include item number.
   - Parse existing rows and terminal archive.
   - Do not resurface fingerprints that are checked, broken out with `→ #123`, or archived.
   - Keep unchecked rows visible and stable where possible.

9. **Dashboard body grammar**
   - Define machine-readable Markdown similar to the security issue grammar (`skills/security-review/SKILL.md:209`, `skills/security-review/SKILL.md:367-388`) and compatible with future feedback handling.
   - Header example:
     - `# Maintenance dashboard`
     - explanatory paragraph.
     - last scan summary line.
   - Sections:
     - `## Open suggestions`
     - `### Tests`, `### Docs`, `### Cleanup / dead code`, `### Simplification`, `### CI / tooling`
   - Canonical row forms:
     - open: `- [ ] <!-- item:N fp:FINGERPRINT cat:CATEGORY --> **TITLE** — \`FILE:LINE\``
     - terminal checked: `- [x] <!-- item:N fp:FINGERPRINT cat:CATEGORY --> **TITLE** — \`FILE:LINE\``
     - broken-out: `- [x] <!-- item:N fp:FINGERPRINT cat:CATEGORY --> ~~**TITLE** — \`FILE:LINE\`~~ → #123`
   - Each row followed by a `<details>` block containing evidence, why it matters, and a small suggested next step.

10. **Weekly cleanup behavior**
    - Remove visible checked/broken-out rows during weekly cleanup after archiving their fingerprints.
    - Preserve human-maintained unchecked rows and details blocks as much as possible.
    - Renumber visible open rows after rewrite.
    - Keep hidden archive bounded to prevent issue body growth.

11. **Run artifact**
    - Write `.lastlight/maintenance-summary.md` (or `{issueDir}/maintenance-summary.md` if the sandbox exposes an issue dir) modelled on the security summary artifact (`skills/security-review/SKILL.md:173-189`).
    - Include repo, prior/new anchor, commits reviewed, files changed, existing open count, terminal archived count, new suggestions added, and no-change reason when applicable.

12. **Verification section**
    - Instruct the agent to report success only after the issue was created/updated or an explicit no-op update completed.
    - Avoid noisy issue comments and Slack summaries in no-change/no-suggestion cases.

### `src/workflows/runner.ts`

Update `gitAccessProfileForWorkflow()` at `src/workflows/runner.ts:133-150`:

- Add `case "maintenance-review":` in the `issues-write` group near `security-review` (`src/workflows/runner.ts:140-145`).
- Do not grant `repo-write`; this workflow creates labels/issues and updates issue bodies only.

### `src/workflows/loader.test.ts`

Extend the existing YAML parse tests in the `loader — security workflow YAML files` area (`src/workflows/loader.test.ts:249-316`) or rename that describe block to cover health/security/maintenance workflows.

Add tests that write temporary YAML files and assert:

- `maintenance-review.yaml` parses as a `health` workflow with one `scan` phase and `skill: maintenance-review`.
- `cron-maintenance.yaml` parses as a cron workflow with:
  - `name: weekly-maintenance-scan`
  - expected weekend schedule, matching the new YAML.
  - `workflow: maintenance-review`

Follow the style of the existing security parse tests (`src/workflows/loader.test.ts:258-275`, `src/workflows/loader.test.ts:298-315`).

### `src/workflows/runner.test.ts`

Extend `gitAccessProfileForWorkflow — security workflows` (`src/workflows/runner.test.ts:1126-1138`):

- Add `it("returns issues-write for maintenance-review", ...)` and assert `gitAccessProfileForWorkflow("maintenance-review") === "issues-write"`.
- Optionally rename the describe block to `gitAccessProfileForWorkflow — issue-writing workflows`.

### No v1 changes

- `src/cli.ts`: do not add a `maintenance` command. The issue's latest scope explicitly excludes CLI/manual triggers for v1; dashboard run API and cron are enough.
- `src/engine/router.ts`: do not add GitHub comment/Slack routing or `maintenance-feedback` routing in v1.
- `src/workflows/schema.ts`, `src/workflows/loader.ts`, `src/cron/jobs.ts`, `src/cron/fanout.ts`: no code changes expected; existing schemas/loaders are generic (`src/workflows/loader.ts:54-80`, `src/workflows/loader.ts:136-138`).

## Implementation approach

1. **Create workflow YAML**
   - Add `workflows/maintenance-review.yaml` with a single `scan` phase.
   - Use `{{models.health}}` and `{{variants.health}}` to keep model configuration consistent with `repo-health`.

2. **Create cron YAML**
   - Add `workflows/cron-maintenance.yaml` with `weekly-maintenance-scan`, weekend schedule, `workflow: maintenance-review`, and `context.mode: scan`.
   - Keep it separate from existing Monday health/security schedules to reduce concurrent load.

3. **Grant issue-write permissions**
   - Add `maintenance-review` to the `issues-write` switch group in `src/workflows/runner.ts`.
   - This allows label creation, parent issue creation, and issue body updates while avoiding repo write access.

4. **Author `skills/maintenance-review/SKILL.md`**
   - Start from the security skill's structure but make clear that v1 maintains one long-lived dashboard, not one issue per scan.
   - Specify exact markers, row grammar, terminal archive, caps, categories, dedupe rules, and low-noise behavior.
   - Include explicit constraints about scanning only recent human-authored changed files.

5. **Add tests**
   - Add loader tests for the new health workflow and cron definition using temporary test YAML strings.
   - Add runner permission test.

6. **Run verification**
   - `npm test -- src/workflows/loader.test.ts src/workflows/runner.test.ts` or `npx vitest run src/workflows/loader.test.ts src/workflows/runner.test.ts` for targeted coverage.
   - `npm test` for full server test suite.
   - `npm run build` for TypeScript type-checking.
   - Lint is not available; guardrails report confirms no lint script is configured.

## Risks and edge cases

- **Dashboard issue duplication:** If the skill searches only by title or only by label, it may miss a migrated issue. Require both `maintenance-scan` label and `lastlight-maintenance-version: 1` marker; if multiple matching open issues exist, reuse the oldest or most recently updated consistently and record the decision in the run artifact.
- **Lost human edits:** Rewriting the full body can discard maintainer edits. The skill should preserve unchecked rows and details blocks where possible, only clean terminal rows, update markers/summary sections, and append/merge new suggestions.
- **Terminal dedupe after cleanup:** Removing checked rows without archiving fingerprints would cause resurfacing. The hidden terminal fingerprint archive must be updated before cleanup and bounded for issue size.
- **Issue body growth:** Preserving too many open rows/details or terminal fingerprints can exceed GitHub limits. Cap new suggestions to 5/run, stop at ~50 open rows, and bound archive retention.
- **No prior marker / force-push / branch rename:** Bootstrap with a 30-day timestamp floor when markers are missing; use timestamp scan as fallback if an anchor SHA is unavailable.
- **Bot/dependency noise:** Lockfile-only and dependency update commits need filtering to prevent low-value suggestions. Reuse security-review's author/subject/lockfile heuristics.
- **Suggestion quality:** Agent-generated maintenance suggestions can become speculative. The skill must require local evidence from recent changed files and allow zero suggestions.
- **Permissions:** `issues-write` is sufficient; granting `repo-write` would unnecessarily expand sandbox trust.
- **Schedule collisions:** Avoid Monday 09:00/10:00 UTC because health/security already run then.

## Test strategy

- **Focused unit tests**
  - `src/workflows/loader.test.ts`: parse `maintenance-review.yaml` as a `kind: health` workflow with one `scan` phase.
  - `src/workflows/loader.test.ts`: parse `cron-maintenance.yaml` as a cron workflow targeting `maintenance-review`.
  - `src/workflows/runner.test.ts`: assert `gitAccessProfileForWorkflow("maintenance-review")` returns `issues-write`.

- **Regression tests to run**
  - `npx vitest run src/workflows/loader.test.ts src/workflows/runner.test.ts`
  - `npm test`
  - `npm run build`

- **Manual sanity checks**
  - Confirm `workflows/maintenance-review.yaml` and `workflows/cron-maintenance.yaml` are included in package files under `workflows`.
  - Optionally run a small script/import through `getWorkflow("maintenance-review")` and `getCronWorkflows()` if tests are not sufficient.

## Estimated complexity

Medium. The harness integration is simple because workflow loading, cron fan-out, and dashboard runs are already generic, but the new skill contract is substantial and must precisely specify issue parsing, dedupe, cleanup, caps, and low-noise behavior to avoid future dashboard churn.
