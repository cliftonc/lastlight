---
name: repo-health
description: Generate a health report for a GitHub repository — open issues, PR backlog, CI status
version: 1.0.0
metadata:
  hermes:
    tags: [github, monitoring, reporting]
    category: maintenance
    requires_toolsets: [terminal]
---

# Repository Health Check Skill

## When to Use
When asked for a repo status report, or on a weekly cron schedule.

## Procedure

1. **Gather metrics** for the target repository:
   - Open issue count, broken down by label/priority
   - Open PR count, and how long each has been open
   - PRs awaiting review (no reviews yet)
   - Issues labeled `needs-info` with no response
   - Recently closed issues and merged PRs (last 7 days)

2. **Identify action items**:
   - PRs open > 7 days with no review
   - Issues labeled `p0-critical` or `p1-high` still open
   - Stale `needs-info` issues (14+ days)
   - PRs with failing CI

3. **Generate a summary report** in markdown:
   ```
   ## Repo Health: owner/repo — YYYY-MM-DD

   ### Overview
   - Open issues: X (Y critical, Z high)
   - Open PRs: X (Y awaiting review)
   - Merged this week: X PRs
   - Closed this week: X issues

   ### Action Items
   - [ ] PR #123 — open 12 days, no review
   - [ ] Issue #456 — p0-critical, open 3 days
   - [ ] Issue #789 — needs-info, stale 21 days

   ### Trends
   - Issue velocity: +X opened, -Y closed (net: ±Z)
   ```

4. **Deliver the report**:
   - In interactive mode: display directly
   - In gateway mode: send to the configured channel

## Pitfalls
- Don't include draft PRs in the "awaiting review" count
- API rate limits: batch requests, don't fetch full history unnecessarily

## Verification
- Spot-check 2-3 numbers against the GitHub web UI
