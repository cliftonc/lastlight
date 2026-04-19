# Architect Plan — Issue #2: Security Review

## Problem Statement

Last Light has no automated security scanning of its own code or managed repos. Known vulnerabilities exist — unescaped `execSync` paths in `mcp-github-app/src/index.js`, `chmod 666 /var/run/docker.sock` in `deploy/entrypoint.sh`, auth tokens in redirect URLs, and a default-empty `WEBHOOK_SECRET` — but nothing surfaces them systematically. The spec (approved in the issue thread) calls for a weekly cron + on-demand workflow that runs open-source scanners (`npm audit`, `semgrep`, `gitleaks`) plus Claude code review, files findings as GitHub issues, and maintains a per-repo `SECURITY.md` to suppress re-filing of accepted risks and false positives.

## Summary of Changes

1. **New workflow + skill**: `security-review` — scan a repo, normalize findings, dedupe, file issues.
2. **New workflow + skill**: `security-feedback` — classify maintainer comments on security issues, update `SECURITY.md` via PR.
3. **New cron entry**: weekly security scan (Monday 10:00).
4. **Router + classifier changes**: add `security` intent for Slack, add `@last-light security-review` structured match for GitHub comments, route comments on `security`-labeled issues to the feedback skill.
5. **CLI verb**: `security` alongside `triage`, `review`, `health`.
6. **Runner permission mapping**: register `security-review` → `issues-write`, `security-feedback` → `repo-write`.
7. **Sandbox Dockerfile**: install `semgrep` + `gitleaks`.
8. **Label**: ensure `security` label exists on managed repos.

## Files to Modify

### New files

| File | Purpose |
|------|---------|
| `workflows/security-review.yaml` | Single-phase health-style workflow, `skill: security-review` |
| `workflows/cron-security.yaml` | `kind: cron`, schedule `"0 10 * * 1"`, references `security-review` |
| `workflows/security-feedback.yaml` | Single-phase workflow, `skill: security-feedback`, triggered by comments on `security`-labeled issues |
| `skills/security-review/SKILL.md` | Scan procedure: clone → read SECURITY.md → run tools → normalize → dedupe → filter → file issues → write summary |
| `skills/security-feedback/SKILL.md` | Classify maintainer comment → update SECURITY.md → open PR |

### Modified files

| File | Line(s) | Change |
|------|---------|--------|
| `sandbox.Dockerfile` | After line 8 (end of apt-get layer) | Add `semgrep` (via `pipx` or `pip3`) and `gitleaks` (prebuilt binary) installs. Python3 is not in the sandbox image — needs adding. |
| `src/engine/classifier.ts:9-17` | CommentIntent union | Add `\| "security"` to the union type |
| `src/engine/classifier.ts:38-76` | CLASSIFIER_PROMPT | Add `SECURITY` category: "The user wants a security scan/review of a repo" with examples |
| `src/engine/classifier.ts:114-124` | intentMap | Add `SECURITY: "security"` entry |
| `src/engine/router.ts:126-141` | Comment handler, after approve/reject match | Add `@last-light security-review` regex match before LLM classification, returning `{ action: "skill", skill: "security-review", context: { repo, sender, source } }` |
| `src/engine/router.ts:167-203` | Issue comment routing | Add check: if issue labels include `security` and intent is not `build`/`approve`/`reject`, route to `security-feedback` skill instead of `issue-comment` |
| `src/engine/router.ts:267-388` | Slack intent switch | Add `case "security"` block (between `review` at line 335 and `explore` at line 349): require `classifiedRepo`, check `isManagedRepo`, dispatch `security-review` skill |
| `src/cli.ts:142-153` | Skill commands block | Add `"security"` to the `includes()` check at line 142 and add `security: "security-review"` to `skillMap` at line 149. Security is repo-level only (like `health`), so reuse the health-style parsing path. |
| `src/workflows/runner.ts:134-148` | `gitAccessProfileForWorkflow` | Add `case "security-review": return "issues-write";` and `case "security-feedback": return "repo-write";` |

## Implementation Approach

### Step 1: Sandbox Dockerfile — install scanners

Edit `sandbox.Dockerfile` to add a new `RUN` layer after line 8:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && pipx install semgrep \
    && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
       | tar -xz -C /usr/local/bin gitleaks \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:${PATH}"
```

Pin `gitleaks` to a specific release for reproducibility. Use `pipx` for semgrep to avoid breaking system packages.

### Step 2: New workflow YAML files

**`workflows/security-review.yaml`** — model on `repo-health.yaml`:
```yaml
kind: health
name: security-review
description: |
  Scan the target repository for security issues using open-source tools
  (npm audit, semgrep, gitleaks) plus Claude code review. File findings
  as GitHub issues, honouring SECURITY.md for known false positives and
  accepted risks.

phases:
  - name: scan
    label: Security scan
    skill: security-review
    model: "{{models.security}}"
```

**`workflows/cron-security.yaml`** — model on `cron-health.yaml`:
```yaml
kind: cron
name: weekly-security-scan
schedule: "0 10 * * 1"
workflow: security-review
context:
  mode: scan
  deliverSlackSummary: true
```

**`workflows/security-feedback.yaml`**:
```yaml
kind: health
name: security-feedback
description: |
  Process maintainer feedback on a security issue — classify intent
  (accept-risk, false-positive, discuss) and update SECURITY.md via PR
  when appropriate.

phases:
  - name: feedback
    label: Security feedback
    skill: security-feedback
    model: "{{models.security}}"
```

### Step 3: New skill — `skills/security-review/SKILL.md`

Detailed procedure the agent follows:

1. Clone the target repo via `mcp_github_clone_repo`.
2. Read `SECURITY.md` if present — parse tool config, accepted risks table, false positives table.
3. Ensure `security` label exists on the repo via `mcp_github_create_label` (idempotent).
4. Run scanners:
   - `npm audit --json` (if `package.json` exists)
   - `semgrep --config auto --json .`
   - `gitleaks detect --no-git --report-format json --report-path /tmp/gitleaks.json .`
   - Claude read-pass: spot-check auth flows, crypto, shell exec (`execSync`, `exec`), env variable handling, webhook verification, secret management.
5. Normalize findings to `{ fingerprint, severity, tool, file, line, rule, title, body, suggestedFix }`.
   - Fingerprint = stable hash of `(tool, rule, file, 3-line-context-window)` for refactor resilience.
   - Map tool severities to `p0-critical` / `p1-high` / `p2-medium` / `p3-low`.
6. Apply severity floor from `SECURITY.md` tool config (default: `medium` — skip `low`/`info`).
7. Filter out findings whose fingerprint prefix matches an entry in SECURITY.md accepted-risks or false-positives tables.
8. Dedupe against existing open `security`-labeled issues via `mcp_github_list_issues` — match by fingerprint in issue body.
9. File new findings via `mcp_github_create_issue` with labels `security` + severity label. Body includes fingerprint, tool+rule, file:line, raw snippet, suggested fix, and curation instructions.
10. Write a summary to `{{issueDir}}/security-summary.md` with counts and issue links.
11. If `context.deliverSlackSummary` is true, output a compact Slack-formatted summary as the final agent output (the cron delivery path posts it).

### Step 4: New skill — `skills/security-feedback/SKILL.md`

1. Read the triggering comment and the issue body (which contains the finding fingerprint).
2. Classify the maintainer's comment intent: `accept-risk`, `false-positive`, `reopen`, `discuss`, `ignore`.
3. If `accept-risk` or `false-positive`:
   - Clone the repo via `mcp_github_clone_repo`.
   - Read current `SECURITY.md` (create if missing with template structure).
   - Parse fingerprint from issue body.
   - Append a row to the appropriate table (accepted risks or false positives) with fingerprint, finding title, maintainer's reason, today's date, and issue link.
   - Commit on a new branch, push, open PR titled `security: record {type} for #{issueNumber}`.
   - Comment on the issue confirming the PR was opened.
4. If `discuss` / `ignore`: reply conversationally, don't change SECURITY.md.

### Step 5: Classifier + Router changes

**classifier.ts:**
- Add `| "security"` to `CommentIntent` (after `"review"` at line 13).
- Add `SECURITY` category to `CLASSIFIER_PROMPT` (after REVIEW at line 45): `SECURITY — The user wants a security scan/review of a repo: "security review cliftonc/repo", "scan for vulnerabilities", "check security".`
- Add example: `"run a security review on cliftonc/lastlight" → INTENT: SECURITY, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE`
- Add `SECURITY: "security"` to `intentMap` (after line 118).

**router.ts:**
- After the approve/reject match block (line 141), add a structured match for `@last-light security-review`:
  ```ts
  const securityMatch = envelope.body.match(/@last-light\s+security-review\b/i);
  if (securityMatch) {
    return {
      action: "skill",
      skill: "security-review",
      context: { repo: envelope.repo, sender: envelope.sender, source: envelope.source },
    };
  }
  ```

- In the issue comment routing section (lines 185-203), add a check before the default `issueSkill` assignment: if the issue has a `security` label (from `envelope.labels`) and the intent is not `build`/`approve`/`reject`, route to `security-feedback`:
  ```ts
  const hasSecurityLabel = (envelope.labels || []).includes("security");
  if (hasSecurityLabel && !["build", "approve", "reject"].includes(intent)) {
    return {
      action: "skill",
      skill: "security-feedback",
      context: { repo: envelope.repo, issueNumber: envelope.issueNumber, ... },
    };
  }
  ```

- In the Slack intent switch (after `case "review"` at line 347), add:
  ```ts
  case "security": {
    if (!classifiedRepo) {
      return { action: "reply", message: "Which repo should I scan? e.g. `security review cliftonc/repo`" };
    }
    if (!isManagedRepo(classifiedRepo)) {
      return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
    }
    return {
      action: "skill",
      skill: "security-review",
      context: { repo: classifiedRepo, sender: envelope.sender, source: envelope.source },
    };
  }
  ```

### Step 6: CLI verb

In `src/cli.ts:142`, add `"security"` to the array:
```ts
if (["triage", "review", "health", "security"].includes(firstArg)) {
```

In `skillMap` (line 149), add:
```ts
security: "security-review",
```

Security is repo-level only (like `health`), so it uses the same code path — no single-issue parsing needed.

### Step 7: Runner permission mapping

In `src/workflows/runner.ts:134-148`, add two cases before `default`:
```ts
case "security-review":
  return "issues-write";
case "security-feedback":
  return "repo-write";
```

### Step 8: Slack delivery for cron runs

The existing pattern works: cron dispatches via `dispatchWorkflow` → `runSimpleWorkflow`. The skill's final output goes through the standard cron result path. The skill itself should format a Slack-friendly summary when `context.deliverSlackSummary` is true.

No changes to `src/index.ts`, `src/cron/jobs.ts`, or `src/cron/scheduler.ts` — the generic cron loader picks up `workflows/cron-security.yaml` automatically.

## Risks and Edge Cases

1. **Semgrep/gitleaks install size**: Adds ~200-400MB to the sandbox image. Mitigation: use `--no-cache-dir`, pin versions, clean up apt lists. Monitor image build time.

2. **Semgrep false positives**: `--config auto` includes community rules that may be noisy for a JS/TS codebase. Mitigation: `SECURITY.md` tool config allows disabling rulesets; severity floor at `medium` skips low-signal findings.

3. **Fingerprint instability across refactors**: A `(tool, rule, file, line-context)` hash breaks when code moves. Mitigation: use a 3-line context window around the finding rather than raw line numbers. Accept that major refactors may re-file some findings — the deduplication against open issues handles re-runs, and SECURITY.md handles curation.

4. **Rate limiting on issue creation**: A first scan of a repo with many findings could hit GitHub API rate limits. Mitigation: the skill should batch and pace issue creation; limit to a configurable max (e.g., 20 issues per run) with a summary note if more were found.

5. **`envelope.labels` availability**: On `comment.created` events, the router may not have issue labels in the envelope. Need to verify the envelope includes labels or fetch them via `mcp_github_get_issue`. Check `src/connectors/github-webhook.ts` for what fields are populated.

6. **Security-feedback skill needs `repo-write`**: This is the most privileged profile after the full build cycle. The scope is narrow (edit SECURITY.md only), but the token grants broader write access. Mitigation: the skill instructions explicitly constrain what files the agent may edit.

7. **Cron Slack delivery path**: Need to verify the cron result output is posted to Slack. The `dispatchWorkflow` return value includes `output` but it's unclear if cron ticks forward it to the delivery service. May need a small addition to the cron dispatch callback in `src/index.ts:918-919`.

## Test Strategy

1. **Unit tests** (extend existing vitest suite):
   - `classifier.test.ts`: Add test cases for `security` intent classification — "security review cliftonc/lastlight", "scan for vulnerabilities", "check security of cliftonc/drizzle-cube".
   - `router.test.ts`: Test `@last-light security-review` structured match routes correctly. Test that comments on `security`-labeled issues route to `security-feedback`. Test Slack `case "security"` dispatches correctly.
   - `loader.test.ts`: Verify new YAML files parse without errors.
   - `runner.test.ts`: Verify `gitAccessProfileForWorkflow` returns correct profiles for `security-review` and `security-feedback`.

2. **Integration test** (manual or CLI):
   - Run `npm run cli -- security cliftonc/lastlight` against the live repo.
   - Verify issues are filed with correct labels (`security` + severity).
   - Verify re-running immediately files zero new issues.
   - Verify `SECURITY.md` entries cause findings to be skipped.

3. **Sandbox image build**:
   - `docker build -f sandbox.Dockerfile .` succeeds.
   - Inside container: `semgrep --version` and `gitleaks version` return successfully.

4. **Type checking**:
   - `npx tsc --noEmit` passes with the new `CommentIntent` union member and router changes.

## Estimated Complexity

**Medium** — 10 files touched (5 new, 5 modified), but the changes follow well-established patterns in the codebase (health workflow, classifier intents, router cases, CLI verbs). The skill SKILL.md files are the bulk of the new content and are declarative markdown. The main risk is the sandbox Dockerfile build and ensuring scanner output parsing works correctly in practice.
