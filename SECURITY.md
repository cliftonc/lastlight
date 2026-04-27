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
| `371224221301e7ba` | Private key PEM reference in architect plan doc | Documentation text describing PEM formats, not real key material | 2026-04-20 | #42 |
| `2358aa69e46dd87c` | Worked example uses realistic API key pattern in SKILL.md | Fabricated example value in documentation, not a real secret | 2026-04-20 | #42 |
| `fef125cf5f9fa722` | RSA private key PEM stub in test fixture | Truncated test fixture stub, not usable key material | 2026-04-20 | #42 |
| `b032e93b57866358` | PKCS8 private key PEM stub in test fixture | Truncated test fixture stub, not usable key material | 2026-04-20 | #42 |
| `7a6c49b010445b8d` | PEM header string literals in validation code matched as private key by gitleaks | PEM header strings used for format validation, not real key material | 2026-04-27 | #47 |
