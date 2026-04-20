# Architect Plan — Issue #42

## Problem Statement

The maintainer (`cliftonc`) has ticked 4 items in the security scan summary issue #42 and commented asking to add them all as false positives to `SECURITY.md`. The ticked items are:

- **Item 1** (fp:`371224221301e7ba`) — Private key PEM reference in architect plan doc (`.lastlight/issue-28/architect-plan.md:97`)
- **Item 4** (fp:`2358aa69e46dd87c`) — Worked example uses realistic API key pattern (`skills/security-review/SKILL.md:415`)
- **Item 5** (fp:`fef125cf5f9fa722`) — RSA private key PEM stub in test fixture (`src/setup.test.ts:56`)
- **Item 6** (fp:`b032e93b57866358`) — PKCS8 private key PEM stub in test fixture (`src/setup.test.ts:64`)

No `SECURITY.md` file exists yet — it must be created from the template defined in `skills/security-feedback/SKILL.md:218-247`.

## Summary of Changes

1. Create `SECURITY.md` at the repo root using the canonical template.
2. Add 4 rows to the **False positives** table (one per ticked item).
3. Commit and push on the existing branch.
4. Open a PR and comment on issue #42.

## Files to Modify

| File | Action | Details |
|------|--------|---------|
| `SECURITY.md` (new) | Create | From template at `skills/security-feedback/SKILL.md:218-247`, with 4 false-positive rows added |

## Implementation Approach

1. **Create `SECURITY.md`** from the template in `skills/security-feedback/SKILL.md § SECURITY.md template`.

2. **Populate the False positives table** with these 4 rows (fingerprint = first 16 hex chars of `fp`):

   | Fingerprint | Title | Reason | Date | Issue |
   |-------------|-------|--------|------|-------|
   | `371224221301e7ba` | Private key PEM reference in architect plan doc | Documentation text describing PEM formats, not real key material | 2026-04-20 | #42 |
   | `2358aa69e46dd87c` | Worked example uses realistic API key pattern in SKILL.md | Fabricated example value in documentation, not a real secret | 2026-04-20 | #42 |
   | `fef125cf5f9fa722` | RSA private key PEM stub in test fixture | Truncated test fixture stub, not usable key material | 2026-04-20 | #42 |
   | `b032e93b57866358` | PKCS8 private key PEM stub in test fixture | Truncated test fixture stub, not usable key material | 2026-04-20 | #42 |

3. **Leave the Accepted risks table empty** — none of the ticked items are accepted risks.

4. **Commit** on the current branch (`lastlight/42-security-scan-2026-04-20`).

5. **Open a PR** titled `security: record false-positives for items 1, 4, 5, 6` targeting `main`.

6. **Comment on issue #42** confirming the PR was opened and that these 4 findings will be suppressed in future scans.

## Risks and Edge Cases

- **Template drift**: The SECURITY.md template is defined in `skills/security-feedback/SKILL.md:218-247`. If it changes, future scans may fail to parse the file. Low risk — the format is stable and well-documented.
- **Fingerprint format**: The scanner matches on the first 16 hex chars of the `fp` field (`skills/security-review/SKILL.md:93`). All 4 fingerprints from the issue body are already 16 hex chars — use them verbatim.
- **No code changes**: This is a metadata-only change. No functional risk.

## Test Strategy

- **Typecheck**: `npx tsc --noEmit` — should pass (no TS files changed).
- **Tests**: `npx vitest run` — should pass (no source changes).
- **Manual verification**: Confirm `SECURITY.md` parses correctly by checking table structure matches the template exactly.

## Estimated Complexity

**Simple** — single new file, well-defined template, no code changes.
