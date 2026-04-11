# Executor Summary — Issue #24: Add "Login with Slack" OAuth to Dashboard

## What Was Done

Implemented Slack OAuth ("Login with Slack") alongside the existing password form on the admin dashboard, following the architect's plan exactly.

## Files Changed

### Backend
- **`src/admin/auth.ts`**: Extended `createToken` to accept optional `method?: "password" | "slack"` parameter, included in token payload. Added `/oauth/slack/` to the auth middleware allowlist.
- **`src/admin/routes.ts`**: Added `slackOAuth*` fields to `AdminConfig`. Extended `/auth-required` to return `slackOAuth: boolean`. Added `GET /oauth/slack/authorize` (redirects to Slack consent) and `GET /oauth/slack/callback` (validates state, exchanges code, checks workspace, creates token, redirects to `/admin?token=`). Imported `arctic`'s `Slack` provider and `hono/cookie` helpers.
- **`src/index.ts`**: Passed `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `SLACK_OAUTH_REDIRECT_URI`, `SLACK_ALLOWED_WORKSPACE` env vars into `mountAdmin`.

### Frontend
- **`dashboard/src/api.ts`**: Extended `authRequired` return type to `{ required: boolean; slackOAuth: boolean }`.
- **`dashboard/src/App.tsx`**: On mount, extracts `?token=` from URL (OAuth callback redirect), stores it via `auth.setToken()`, strips param from history via `replaceState`, then proceeds with normal auth check. Passes `slackOAuth` flag to `Login`.
- **`dashboard/src/components/Login.tsx`**: Added `slackOAuth` prop. When true, shows "Login with Slack" button above a divider above the password form. Button navigates to `/admin/api/oauth/slack/authorize` (full-page redirect). Shows "Redirecting..." while navigating.

### Config
- **`.env.example`**: Added Slack OAuth section with the four new env vars.

### Tests (new)
- **`src/admin/auth.test.ts`**: 7 tests — `createToken`/`verifyToken` with method field, backward compat, tampering.
- **`src/admin/routes.test.ts`**: 12 tests — `/auth-required` returns correct `slackOAuth` flag, `/oauth/slack/authorize` redirects or 404s, `/oauth/slack/callback` validates state, workspace check (403 on mismatch, redirect on match), password login still works.

## Test Results

```
Test Files  12 passed (12)
     Tests  231 passed | 1 todo (232)
  Start at  10:06:16
  Duration  2.01s
```

(212 existing + 19 new = 231 passed, zero failures)

## Lint Results

No linter configured (confirmed in guardrails report — non-blocking).

## Typecheck Results

```
npx tsc --noEmit
(no output — clean)
```

## Deviations from Plan

None. All planned steps implemented as specified. The Arctic Slack provider uses the OpenID Connect endpoint (`https://slack.com/openid/connect/authorize`) with scopes `openid profile`, matching the plan's primary recommendation.

`SLACK_ALLOWED_WORKSPACE` accepts either a team domain or team_id — both are checked against `auth.test` response fields.
