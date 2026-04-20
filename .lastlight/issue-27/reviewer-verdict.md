# Reviewer Verdict — Issue #27

VERDICT: APPROVED

## Summary

The GitHub OAuth implementation faithfully mirrors the existing Slack flow, correctly handles the key security subtleties (state cookie CSRF protection, `redirect: "manual"` for the org membership check to catch 302 responses, `encodeURIComponent` on org/login in the membership URL), and all 244 tests pass with 13 new cases covering the full happy/unhappy path matrix.

## Issues

### Critical

None.

### Important

None.

### Suggestions

- `src/admin/routes.ts:374-384` — `userRes.json()` is called without first checking `userRes.ok`. If GitHub's `/user` endpoint returns a non-200 (e.g. 401 revoked token), the response body is a GitHub error object (no `login`), so the `!userInfo.login` guard on line 382 correctly blocks auth. The 502 is appropriate, but the log message says "missing login field" rather than surfacing the HTTP status, which makes failures harder to diagnose. Consider:
  ```typescript
  if (!userRes.ok) {
    console.error(`GitHub /user returned ${userRes.status}`);
    return c.json({ error: "GitHub userInfo failed" }, 502);
  }
  ```

- `src/admin/routes.ts:346` — `read:org` scope is requested unconditionally in the authorize route, even when `GITHUB_ALLOWED_ORG` is not configured. When org restriction is off, any authenticated GitHub user is allowed in, so `read:org` is superfluous and unnecessarily widens the token's permissions. Consider requesting `["read:user"]` by default and adding `"read:org"` only when `config.githubAllowedOrg` is set (the value is not available in the authorize handler, but the boolean flag `githubAllowedOrg` could be threaded in, or a simpler local check applied).

### Nits

- `src/admin/routes.test.ts:551-562` — the `mockGithubFetch` helper defaults `orgStatus` to `204` when undefined, but the default is only used in the no-org-restriction tests (which don't hit the org branch at all). The default is harmless but slightly misleading — a comment clarifying this would help future readers.

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  12 passed (12)
      Tests  244 passed | 1 todo (245)
   Start at  23:03:26
   Duration  2.16s (transform 350ms, setup 0ms, import 620ms, tests 315ms, environment 1ms)
```
