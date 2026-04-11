# Reviewer Verdict — Issue #24

VERDICT: REQUEST_CHANGES

## Summary

The Slack OAuth implementation is largely correct and well-structured — state parameter generation, cookie-based CSRF protection, workspace restriction, and frontend token stripping all follow the architect's plan. Two important security issues prevent approval: the state cookie is never cleared after validation (enabling replay within its 10-minute window), and the auth middleware bypass pattern uses `path.includes("/oauth/slack/")` instead of a precise match, which is imprecise and would allow any crafted path segment containing that string to bypass authentication (low exploitability today given current routes, but fragile).

## Issues

### Critical

None.

### Important

**1. State cookie not deleted after use — replay window**

`src/admin/routes.ts:255–258`

After the callback validates `storedState !== state`, the `slack_oauth_state` cookie is never cleared. Within its 10-minute `maxAge`, an attacker who intercepts a valid callback URL (e.g. via Referer, browser history, or shared device) can replay the same `state` + `code` pair to obtain a second token if the authorization code is somehow reusable, or to re-trigger the callback flow.

Fix: delete the cookie immediately after reading it in the callback handler:

```ts
// src/admin/routes.ts — after getCookie line
deleteCookie(c, "slack_oauth_state", { path: "/" });
```

Import `deleteCookie` from `hono/cookie` alongside the existing imports.

**2. Auth middleware bypass pattern is overly broad**

`src/admin/auth.ts:47`

```ts
path.includes("/oauth/slack/")
```

This bypasses auth for any URL whose pathname contains the substring `/oauth/slack/`, not just the two intended routes. While no current Hono route would match a crafted path like `/admin/api/sessions/x/oauth/slack/y` (Hono's router won't route it), the middleware check would skip token validation for such a request before Hono 404s it. This is a defence-in-depth failure and becomes exploitable if a wildcard or catch-all route is added in future.

Fix: use exact-match logic instead of substring check:

```ts
// src/admin/auth.ts
path === "/admin/api/oauth/slack/authorize" ||
path === "/admin/api/oauth/slack/callback" ||
```

Or, since the routes sub-app is mounted at `/admin/api` and the middleware sees paths relative to the sub-app:

```ts
path.endsWith("/oauth/slack/authorize") ||
path.endsWith("/oauth/slack/callback")
```

**3. OAuth error detail leaked to client**

`src/admin/routes.ts:280, 298`

```ts
return c.json({ error: "Slack auth.test failed", detail: authTest.error }, 502);
return c.json({ error: "OAuth exchange failed", detail: msg }, 502);
```

The raw Slack API error string and raw exception message are returned to the browser. This can expose internal network topology, token fragments in exception messages, or Arctic library internals. Log the detail server-side; return a generic message to the client.

```ts
console.error("Slack auth.test failed:", authTest.error);
return c.json({ error: "Slack auth.test failed" }, 502);
```

```ts
console.error("OAuth exchange failed:", err);
return c.json({ error: "OAuth exchange failed" }, 502);
```

### Suggestions

**4. State comparison is not constant-time**

`src/admin/routes.ts:258`

```ts
storedState !== state
```

The state parameter is a 32-character hex string. Using `!==` is a timing-safe comparison for this length in practice (both branches are short-circuit evaluated and string comparison terminates early on mismatch), but using `timingSafeEqual` is the correct approach for any secret comparison, consistent with how password comparison is done elsewhere in the same file.

```ts
import { timingSafeEqual, randomBytes } from "node:crypto";
// ...
const safe = storedState.length === state.length &&
  timingSafeEqual(Buffer.from(storedState), Buffer.from(state));
if (!storedState || !state || !safe) {
```

**5. `slackOAuthRedirectUri` falls back to empty string**

`src/admin/routes.ts:238, 268`

```ts
config.slackOAuthRedirectUri ?? ""
```

An empty redirect URI will be rejected by Slack's OAuth server and produce a confusing error. Consider asserting it is set when Slack OAuth is enabled, or at minimum logging a warning at startup.

**6. Token stored in `localStorage`**

`dashboard/src/api.ts:180`

Pre-existing, not introduced by this PR. Noted for completeness: `localStorage` is accessible to any same-origin script, making XSS → token theft straightforward. Out of scope for this review but worth a follow-up issue.

### Nits

- The `if (!cancelled) setSlackOAuth(oauthEnabled)` check on `App.tsx:357` is redundant — the `if (cancelled) return` guard on line 356 already ensures cancelled is false at that point.
- `slackOAuthRedirectUri` is optional in `AdminConfig` but the executor summary says it is a required env var for Slack OAuth to work. The type could reflect this as required when `slackOAuthClientId` and `slackOAuthClientSecret` are set, though TypeScript's structural types make conditional-required fields awkward.

## Test Results

```
> lastlight@2.0.0 test
> vitest run

 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  12 passed (12)
      Tests  231 passed | 1 todo (232)
   Start at  10:08:26
   Duration  2.05s (transform 330ms, setup 0ms, import 581ms, tests 266ms, environment 1ms)
```

All 231 tests pass. The new test suite covers the key OAuth paths well: state mismatch → 400, workspace mismatch → 403, match by team_id → 302 with token, no restriction → 302 with token, disabled → 404. The state-cookie-not-cleared deficiency means the replay test case is missing from the suite.
