# Security Feedback Skill

Process a maintainer's comment on a security-labelled issue. Classify their intent and, when appropriate, update `SECURITY.md` via a PR to suppress the finding in future scans.

## Context

- `context.repo` — `owner/name` of the repo
- `context.issueNumber` — the security issue number
- `context.commentBody` — the triggering comment text
- `context.sender` — GitHub login of the commenter

## Procedure

### 1. Read the issue and comment

Read the issue body to extract:
- The finding fingerprint from `<!-- fingerprint: <hex> -->`
- The finding title and tool

The `context.commentBody` is the maintainer's comment.

### 2. Classify intent

Classify the comment into one of:

- **accept-risk** — Maintainer acknowledges the risk and accepts it. Signals: "accept-risk:", "we know about this", "intentional", "won't fix", "accepted".
- **false-positive** — Maintainer says the finding is not a real security issue. Signals: "false-positive:", "false positive", "not a vulnerability", "not applicable".
- **reopen** — Maintainer wants a previously suppressed finding re-evaluated. Signals: "reopen", "re-evaluate", "this is real".
- **discuss** — Maintainer is asking a question or discussing without taking action.
- **ignore** — Comment is noise (e.g. a thank-you, unrelated remark).

### 3. Act on classification

#### accept-risk or false-positive

1. Clone the repo via `mcp_github_clone_repo`.
2. Read `SECURITY.md` if it exists. If not, create it with the template below.
3. Parse the fingerprint from the issue body.
4. Append a row to the appropriate table:

   | Column | Value |
   |--------|-------|
   | Fingerprint | First 16 hex chars of fingerprint |
   | Title | Finding title |
   | Reason | Maintainer's stated reason (extract from comment) |
   | Date | Today's date (YYYY-MM-DD) |
   | Issue | `#{issueNumber}` |

5. Commit the change on a new branch named `security/feedback-{issueNumber}`.
6. Push and open a PR titled `security: record {accept-risk|false-positive} for #{issueNumber}`.
7. Comment on the issue: "Opened PR #{prNumber} to record this in SECURITY.md. Once merged, this finding will be suppressed in future scans."

#### discuss

Reply conversationally to the comment. Provide context about the finding (explain the risk, the tool that found it, or the suggested fix). Do not modify SECURITY.md.

#### ignore or reopen

- **ignore**: Take no action.
- **reopen**: Comment explaining that to re-evaluate, a maintainer should run `@last-light security-review` on the repo. Do not modify SECURITY.md.

## SECURITY.md template

```markdown
# SECURITY.md

This file configures the Last Light security scanner for this repository.

## Tool configuration

| Tool | Severity floor |
|------|---------------|
| npm-audit | medium |
| semgrep | medium |
| gitleaks | high |
| claude | medium |

## Accepted risks

Findings in this table are known risks the maintainers have explicitly accepted.
The scanner will not re-file issues for these findings.

| Fingerprint | Title | Reason | Date | Issue |
|-------------|-------|--------|------|-------|

## False positives

Findings in this table have been classified as not real security issues.
The scanner will not re-file issues for these findings.

| Fingerprint | Title | Reason | Date | Issue |
|-------------|-------|--------|------|-------|
```
