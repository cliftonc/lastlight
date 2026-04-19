# Security Review Skill

Scan the target repository for security vulnerabilities using open-source tools and Claude code review. File findings as GitHub issues. Honour `SECURITY.md` to suppress accepted risks and false positives.

## Context

- `context.repo` — `owner/name` of the repo to scan
- `context.deliverSlackSummary` — if true, output a compact Slack-formatted summary as the final response
- `context.issueDir` — directory for writing the summary file (e.g. `.lastlight/issue-N`)

## Procedure

### 1. Clone and read SECURITY.md

Clone the target repo via `mcp_github_clone_repo`. If `SECURITY.md` exists at the repo root, read it and parse:

- **Tool config** — per-tool severity floors (default: `medium`; skip `low`/`info`)
- **Accepted risks table** — fingerprints of findings the maintainer has explicitly accepted
- **False positives table** — fingerprints the maintainer has classified as not real

### 2. Ensure `security` label exists

Call `mcp_github_create_label` with `{ name: "security", color: "ee0701", description: "Security finding" }`. The call is idempotent — ignore 422 Unprocessable Entity (label already exists).

### 3. Run scanners

Run only the scanners applicable to the repo:

- **npm audit**: If `package.json` exists, run `npm audit --json`. Parse the JSON output for advisory objects.
- **semgrep**: Run `semgrep --config auto --json .` from the repo root. Parse `results[]` from the JSON output.
- **gitleaks**: Run `gitleaks detect --no-git --report-format json --report-path /tmp/gitleaks.json .` then read `/tmp/gitleaks.json`.
- **Claude read-pass**: Spot-check auth flows, crypto usage, shell exec calls (`execSync`, `exec`, `spawn`), env variable handling, webhook secret verification, and secret/token management. Look for:
  - Unescaped shell exec arguments
  - Hardcoded secrets or default-empty secret env vars
  - Auth tokens in URLs or logs
  - World-writable file/socket permissions
  - Missing or bypassable webhook signature verification

### 4. Normalize findings

Convert all findings to a unified shape:

```
{
  fingerprint: string,   // stable hash: sha1(tool + ":" + rule + ":" + file + ":" + 3-line-context)
  severity: "p0-critical" | "p1-high" | "p2-medium" | "p3-low",
  tool: string,          // "npm-audit" | "semgrep" | "gitleaks" | "claude"
  file: string,
  line: number,
  rule: string,
  title: string,
  body: string,          // markdown — snippet, explanation, suggested fix
}
```

Severity mapping:

| Tool | Source severity | Mapped to |
|------|----------------|-----------|
| npm audit | critical | p0-critical |
| npm audit | high | p1-high |
| npm audit | moderate | p2-medium |
| npm audit | low | p3-low |
| semgrep | ERROR | p1-high |
| semgrep | WARNING | p2-medium |
| semgrep | INFO | p3-low |
| gitleaks | (all) | p1-high |
| claude | critical | p0-critical |
| claude | high | p1-high |
| claude | medium | p2-medium |
| claude | low | p3-low |

### 5. Apply severity floor

Drop any finding below the severity floor from `SECURITY.md` tool config (default: `medium`, meaning drop `p3-low`).

### 6. Filter accepted risks and false positives

Drop any finding whose fingerprint prefix (first 16 hex chars) matches an entry in the SECURITY.md accepted-risks or false-positives tables.

### 7. Deduplicate against open issues

Call `mcp_github_list_issues` with `{ labels: "security", state: "open" }`. For each existing issue, extract the fingerprint from the issue body (look for `<!-- fingerprint: <hex> -->`). Drop any finding whose fingerprint matches an existing open issue.

### 8. File new issues

For each remaining finding, call `mcp_github_create_issue` with:

- **title**: `[{tool}] {title}`
- **labels**: `["security", "{severity}"]`
- **body**:

```markdown
<!-- fingerprint: {fingerprint} -->

**Tool**: {tool} — {rule}
**File**: `{file}:{line}`
**Severity**: {severity}

### Finding

{snippet — fenced code block with the relevant lines}

### Explanation

{explanation of why this is a security issue}

### Suggested fix

{concrete fix with code example if applicable}

---

_To suppress this finding in future scans, comment on this issue with one of:_
- `@last-light accept-risk: {reason}` — adds to SECURITY.md accepted risks
- `@last-light false-positive: {reason}` — adds to SECURITY.md false positives
```

Limit to 20 new issues per run. If more findings remain after the limit, note the count in the summary.

### 9. Write summary

Write a summary to `{issueDir}/security-summary.md`:

```markdown
# Security Scan Summary — {repo}

**Date**: {date}
**Scanner results**: npm audit: {n}, semgrep: {n}, gitleaks: {n}, claude: {n}
**After filtering**: {n} new issues filed, {n} suppressed (accepted/FP), {n} already open

## New issues filed

{list of issue links with severity and title}

## Suppressed findings

{count} findings suppressed by SECURITY.md ({n} accepted risks, {n} false positives)
```

### 10. Slack summary (optional)

If `context.deliverSlackSummary` is true, output as the final response:

```
*Security scan: {repo}*
{n} new issues filed | {n} suppressed | {n} already tracked
{list: severity emoji + title + issue link, max 5}
{if >5: "+{n} more — see {link to summary issue}"}
```

Use severity emoji: 🔴 p0-critical, 🟠 p1-high, 🟡 p2-medium, 🔵 p3-low.
