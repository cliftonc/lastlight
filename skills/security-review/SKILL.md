# Security Review Skill

Scan the target repository for security vulnerabilities using open-source tools (`npm audit`, `semgrep`, `gitleaks`) plus a Claude code read-pass. File **one summary issue per run**, dated, containing a GitHub task list of all findings — Renovate-style. Honour `SECURITY.md` to suppress accepted risks and false positives.

A maintainer can later comment on the summary issue to break selected findings out into individual issues (see the `security-feedback` skill). The exact issue structure defined in **§ Issue format** below is the contract between the two skills — **if you change it here, update `skills/security-feedback/SKILL.md` in lockstep**.

## Context

- `context.repo` — `owner/name` of the repo to scan
- `context.deliverSlackSummary` — if true, output a one-line Slack summary as the final response
- `context.issueDir` — directory for writing the run summary file (e.g. `.lastlight/security-<date>`)

## Procedure

### 1. Clone and read SECURITY.md

Clone the target repo via `mcp_github_clone_repo`. If `SECURITY.md` exists at the repo root, parse:

- **Tool config** — per-tool severity floors (default: `medium`; skip `low`/`info`)
- **Accepted risks table** — fingerprints of findings the maintainer has accepted
- **False positives table** — fingerprints classified as not real

### 2. Ensure labels exist

Call `mcp_github_create_label` for each of (idempotent — ignore 422 "already exists"):

| Label | Color | Purpose |
|-------|-------|---------|
| `security` | `ee0701` | Any security-related issue |
| `security-scan` | `fbca04` | The per-run summary issue (distinguishes from sub-issues) |
| `p0-critical` | `b60205` | Severity |
| `p1-high` | `d93f0b` | Severity |
| `p2-medium` | `fbca04` | Severity |
| `p3-low` | `0e8a16` | Severity |

### 3. Run scanners

Run only the scanners applicable to the repo:

- **npm audit**: if `package.json` exists, `npm audit --json`.
- **semgrep**: `semgrep --config auto --json .` from the repo root.
- **gitleaks**: `gitleaks detect --no-git --report-format json --report-path /tmp/gitleaks.json .` then read `/tmp/gitleaks.json`.
- **Claude read-pass**: spot-check auth flows, crypto usage, shell exec (`execSync`, `exec`, `spawn`), env-variable handling, webhook signature verification, secret/token management. Flag:
  - Unescaped shell exec arguments
  - Hardcoded secrets or default-empty secret env vars
  - Auth tokens in URLs or logs
  - World-writable file/socket permissions
  - Missing or bypassable webhook signature verification

### 4. Normalize findings

Convert each finding to:

```
{
  fingerprint: string,   // sha1(tool + ":" + rule + ":" + file + ":" + 3-line-context), LOWERCASE HEX
  severity: "p0-critical" | "p1-high" | "p2-medium" | "p3-low",
  tool: "npm-audit" | "semgrep" | "gitleaks" | "claude",  // lowercase, hyphenated
  rule: string,          // tool-native rule id, keep as-is (no spaces)
  file: string,          // path relative to repo root, forward slashes
  line: number,          // 1-based; use 0 when a finding isn't line-scoped (e.g. npm-audit)
  title: string,         // short, one line, NO backticks or asterisks
  language: string,      // fenced-code language tag for the snippet (e.g. "javascript", "typescript", "")
  snippet: string,       // code excerpt, no surrounding fences
  explanation: string,   // why this is a security issue (markdown, multi-line ok)
  suggestedFix: string,  // concrete fix with code example where possible (markdown)
}
```

Severity mapping:

| Tool | Source severity | Mapped to |
|------|----------------|-----------|
| npm-audit | critical | p0-critical |
| npm-audit | high | p1-high |
| npm-audit | moderate | p2-medium |
| npm-audit | low | p3-low |
| semgrep | ERROR | p1-high |
| semgrep | WARNING | p2-medium |
| semgrep | INFO | p3-low |
| gitleaks | (all) | p1-high |
| claude | critical | p0-critical |
| claude | high | p1-high |
| claude | medium | p2-medium |
| claude | low | p3-low |

### 5. Apply severity floor

Drop any finding below the SECURITY.md severity floor (default: `medium` → drops `p3-low`).

### 6. Filter accepted risks and false positives

Drop any finding whose fingerprint prefix (first 16 hex chars) appears in the SECURITY.md accepted-risks or false-positives tables.

### 7. Sort and cap

Sort findings by `(severity, file, line)` in this exact order:

1. Severity rank: `p0-critical` < `p1-high` < `p2-medium` < `p3-low`
2. Then `file` ascending (string compare)
3. Then `line` ascending

**Severity-aware cap (the issue body has a hard 65,536-char GitHub limit, and detailed findings blow through that on noisy repos):**

- Keep **ALL** `p0-critical` findings.
- Keep **ALL** `p1-high` findings.
- For `p2-medium` + `p3-low` combined, keep at most **10** (the first 10 after the sort above — severity then file then line, so all medium come before any low). Drop the rest.

Assign `item` numbers 1-based, top-to-bottom, across the **kept** findings (so items 1–2 might be `p0-critical`, items 3–7 are `p1-high`, items 8–17 are the kept medium/low).

`overflow` = total findings that survived filtering minus kept findings. The dropped items are counted in `overflow` and surfaced in the overflow note. Re-running the scan after `SECURITY.md` is tightened is the way to dig into them — we don't bloat one issue with everything.

### 8. Early exit: no findings

If the filtered-and-capped list is empty, **do not** create the summary issue. Write the run summary file (§ 10) and emit the all-clear Slack line (§ 11) if requested.

### 9. Compose and create the summary issue

Use the exact grammar in **§ Issue format** below. Call `mcp_github_create_issue` with:

- `title`: `Security scan — {YYYY-MM-DD}` (UTC date)
- `labels`: `["security", "security-scan"]`
- `body`: the rendered body described in § Issue format

Record the new issue number as `summaryIssueNumber`. Do **not** close or touch prior `security-scan`-labelled issues — each scan is a point-in-time snapshot; maintainers process them at their own pace.

### 10. Write the run summary file

Write `{issueDir}/security-summary.md`:

```markdown
# Security Scan Summary — {repo}

**Date**: {YYYY-MM-DD}
**Summary issue**: #{summaryIssueNumber} (or "none — no findings")

**Scanner raw counts**: npm-audit: {n}, semgrep: {n}, gitleaks: {n}, claude: {n}
**After severity floor**: {n}
**After SECURITY.md filtering**: {n} (filed)
**Suppressed**: {n} (accepted: {nA}, false-positive: {nFP})
{if overflow > 0}: **Overflow**: {overflow} lower-severity findings omitted from the summary issue (cap: ALL critical/high + first 10 medium/low)
```

### 11. Slack summary (optional)

If `context.deliverSlackSummary` is `true`, output as the final agent response:

- **With findings**:
  ```
  *Security scan: {repo}* — {n} findings filed in #{summaryIssueNumber}
  Critical: {nC} · High: {nH} · Medium: {nM} · Low: {nL}
  ```
- **No findings**:
  ```
  *Security scan: {repo}* — clean (no findings above severity floor).
  ```

Otherwise output the contents of the run summary file as the final response.

---

## § Issue format

This is the **contract** between `security-review` (producer) and `security-feedback` (consumer). Every rule here is machine-parsed; do not deviate.

### Title

```
Security scan — YYYY-MM-DD
```

- Exactly one em-dash (` — `, U+2014), surrounded by single spaces.
- Date is the scan's UTC date in ISO form.
- Same-day re-scans produce a second issue with the same title. GitHub disambiguates by issue number; the scanner never edits a prior-run issue.

### Body

The body is assembled from seven blocks, in this exact order, separated by blank lines:

```
{header comments}

{intro paragraph}

{how-to-respond section}

{summary table}

{suppression note}

{overflow note — omitted when overflow == 0}

{findings sections}
```

#### Block 1 — header comments

Three HTML comments, each on its own line, in this exact order:

```
<!-- lastlight-security-scan-version: 1 -->
<!-- lastlight-security-scan-date: YYYY-MM-DD -->
<!-- lastlight-security-scan-ts: YYYY-MM-DDTHH:MM:SSZ -->
```

- `version` is a format version. Bump if the structure changes incompatibly — `security-feedback` will check this and refuse to parse unknown versions.
- `date` matches the title.
- `ts` is an ISO-8601 UTC timestamp with second precision (no milliseconds).

#### Block 2 — intro paragraph

Exactly one paragraph, verbatim:

```
Automated security scan on YYYY-MM-DD. Each row below is a finding — tick the box once the underlying issue is resolved or recorded in `SECURITY.md`.
```

#### Block 3 — how-to-respond section

Verbatim, including the heading:

```
## How to respond

**Preferred flow** — tick the boxes on the findings you want broken out, then comment:

- `@last-light create issues` — files one issue per **ticked** finding (default)

**Other shortcuts:**

- `@last-light create issues for the criticals` — every Critical finding (ticked or not)
- `@last-light create issues for the highs` — same, for High
- `@last-light create issues for items 1, 3, 5` — specific items by number (1-based, top to bottom)
- `@last-light create issues for all` — every finding in this scan
- `@last-light accept-risk for item N: <reason>` — suppress this finding in future scans
- `@last-light false-positive for item N: <reason>` — suppress this finding in future scans
- Comment freely to ask questions or discuss
```

(Item positions in commands map to the `item:N` HTML-comment markers defined below. Ticking a box in GitHub's UI rewrites the row from `[ ]` to `[x]` — the feedback skill treats that as your selection.)

#### Block 4 — summary table

Verbatim header, with numbers substituted. Always include all four severity rows, even when the count is 0.

`{nC}`, `{nH}`, `{nM}`, `{nL}` and `{nTotal}` are **TRUE counts** (post-filtering, pre-cap) — i.e. how many findings of each severity actually survived the SECURITY.md filtering, regardless of whether each individual row is listed below the cap. The same numbers appear in the `### 🔴 Critical ({nC})` etc. section headers. The overflow note (Block 6) communicates how many of those counts were truncated from the listed rows.

```
## Summary

| Severity | Count |
|----------|------:|
| Critical | {nC} |
| High     | {nH} |
| Medium   | {nM} |
| Low      | {nL} |
| **Total**| **{nTotal}** |
```

#### Block 5 — suppression note

A single line:

```
Suppressed by `SECURITY.md`: {nSuppressed} (accepted: {nA}, false-positives: {nFP}). Below severity floor: {nFloor}.
```

Set each count to 0 when N/A. Emit the line unconditionally so the structure is stable.

#### Block 6 — overflow note

Emit **only** when `overflow > 0`:

```
> **Note** — {overflow} lower-severity findings are not listed here. The cap is: ALL critical and high, plus the first 10 medium/low (after sort). Tighten `SECURITY.md` severity floors or break out items from this scan, then re-run to surface the rest.
```

#### Block 7 — findings sections

Four sections, in this **exact order** (Critical → High → Medium → Low). Always emit all four headers, even when a section has zero findings — the feedback skill relies on stable anchors.

The header counts (`{nC}` etc.) are the **true** post-filter counts, identical to those in Block 4's summary table. The rows listed under each header are subject to the § 7 cap: critical and high are always complete; medium + low are truncated to the first 10 combined. When a section is partially listed, append `(showing first N of {nM})` after the marker — see the per-section header rule below.

```
## Findings

### 🔴 Critical ({nC})

{rows or "_No findings._"}

### 🟠 High ({nH})

{rows or "_No findings._"}

### 🟡 Medium ({nM}){if truncated: " (showing first {kM} of {nM})"}

{rows or "_No findings._"}

### 🟢 Low ({nL}){if truncated: " (showing first {kL} of {nL})"}

{rows or "_No findings._"}
```

Where `kM` and `kL` are the actual rows listed in this issue (sum of the two ≤ 10). When `kM == nM` or `kL == nL` (no truncation in that section), omit the parenthetical.

#### Finding-row grammar

Every finding is exactly two lines: a task-list row, then a `<details>` block (one blank line between rows within a section).

The task-list row is **one physical line** with this exact shape:

```
- [ ] <!-- item:N fp:FINGERPRINT --> **TITLE** — `FILE:LINE` (TOOL · `RULE`)
```

Matched by this canonical regex (multiline, case-sensitive) — covers all three row states:

```
/^- \[([ x])\] <!-- item:(\d+) fp:([0-9a-f]{8,}) --> (?:~~)?\*\*(.+?)\*\* — `([^`]+):(\d+)` \(([a-z][a-z0-9-]*) · `([^`]+)`\)(?:~~ → #(\d+))?$/m
```

Capture groups, in order:

1. `checkbox` — `" "` (unticked) or `"x"` (ticked or broken-out)
2. `itemNumber` (1-based across all severities)
3. `fingerprint` (lowercase hex, ≥ 8 chars)
4. `title` (plain text; no backticks, no asterisks)
5. `file` (no backticks, forward-slash path)
6. `line` (integer; use `0` when not line-scoped)
7. `tool` (lowercase, hyphenated — e.g. `npm-audit`, `semgrep`, `gitleaks`, `claude`)
8. `rule` (the tool's native rule id; may contain dots, hyphens)
9. `subIssueNumber` — present **only** when the row has been broken out to a sub-issue; `undefined` otherwise

Derived state (the feedback skill computes these from the captures):

| State | Written as | `checkbox` | `subIssueNumber` |
|-------|------------|------------|------------------|
| **pending** | `- [ ] <!-- item:N fp:FP --> **TITLE** — …` | `" "` | `undefined` |
| **user-ticked** (maintainer clicked the box in GitHub's UI) | `- [x] <!-- item:N fp:FP --> **TITLE** — …` | `"x"` | `undefined` |
| **broken-out** (feedback skill created a sub-issue) | `- [x] <!-- item:N fp:FP --> ~~**TITLE** — …~~ → #SUBISSUE` | `"x"` | the sub-issue number |

Rules:

- `alreadyBrokenOut` ≡ `subIssueNumber != null`. Broken-out rows are immutable — the feedback skill never re-opens them, never touches their checkbox, never re-creates sub-issues from them.
- `userTicked` ≡ `checkbox === "x" && subIssueNumber == null`. These are the candidates the default `@last-light create issues` command selects.
- When creating sub-issues from ticked rows, the feedback skill transitions each row from **user-ticked** → **broken-out** by wrapping the visible text in `~~…~~` and appending ` → #{subIssueNumber}`. The checkbox stays `[x]`; the strikethrough + link is the canonical broken-out marker.
- Un-ticking (moving a user-ticked row back to `[ ]`) is fine — the row just becomes pending again. The scanner doesn't police this.

The per-finding detail block follows immediately on the next line:

````
<details><summary>Details</summary>

```{LANGUAGE}
{SNIPPET}
```

{EXPLANATION}

**Suggested fix:** {SUGGESTED_FIX}

</details>
````

Rules:
- `LANGUAGE` is the fenced-code language tag; empty string when unknown.
- `SNIPPET` is the code excerpt; no surrounding fences, no trailing blank line inside the fence.
- `EXPLANATION` and `SUGGESTED_FIX` are markdown strings; they may contain their own fenced code blocks and line breaks.
- The `<details>` block ends with `</details>` on its own line.

### Worked example

A scan with 1 critical + 1 high finding renders like:

````markdown
<!-- lastlight-security-scan-version: 1 -->
<!-- lastlight-security-scan-date: 2026-04-21 -->
<!-- lastlight-security-scan-ts: 2026-04-21T10:00:00Z -->

Automated security scan on 2026-04-21. Each row below is a finding — tick the box once the underlying issue is resolved or recorded in `SECURITY.md`.

## How to respond

- `@last-light create issues for the criticals` — file individual issues for every Critical finding
- `@last-light create issues for the highs` — same, for High
- `@last-light create issues for items 1, 3, 5` — file issues for specific items by number (1-based, top to bottom)
- `@last-light create issues for all` — every finding in this scan
- `@last-light accept-risk for item N: <reason>` — suppress this finding in future scans
- `@last-light false-positive for item N: <reason>` — suppress this finding in future scans
- Comment freely to ask questions or discuss

## Summary

| Severity | Count |
|----------|------:|
| Critical | 1 |
| High     | 1 |
| Medium   | 0 |
| Low      | 0 |
| **Total**| **2** |

Suppressed by `SECURITY.md`: 0 (accepted: 0, false-positives: 0). Below severity floor: 0.

## Findings

### 🔴 Critical (1)

- [ ] <!-- item:1 fp:abc123def4567890 --> **Command injection in git clone** — `mcp-github-app/src/index.js:42` (semgrep · `javascript.lang.security.exec-shell-command`)
<details><summary>Details</summary>

```javascript
execSync(`git clone ${userInput}`)
```

`userInput` originates from an HTTP request and is concatenated directly into a shell command, allowing arbitrary command execution.

**Suggested fix:** use `execFileSync('git', ['clone', userInput])` so arguments aren't re-parsed by a shell.

</details>

### 🟠 High (1)

- [ ] <!-- item:2 fp:def456abc7890123 --> **Hardcoded API key in config** — `src/config.ts:18` (gitleaks · `generic-api-key`)
<details><summary>Details</summary>

```typescript
const API_KEY = "sk_live_abc123..."
```

A live API key is committed to the repo. Anyone with read access to the repo (or the git history of a former branch) can use it.

**Suggested fix:** move the key to an environment variable (`process.env.API_KEY`) and rotate the exposed one immediately.

</details>

### 🟡 Medium (0)

_No findings._

### 🟢 Low (0)

_No findings._
````
