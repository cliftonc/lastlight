# Architect Plan — Issue #24: Add "Login with Slack" OAuth to Dashboard

## Problem Statement

The Last Light dashboard currently supports only a single shared password for authentication (`src/admin/auth.ts:6-11`, `src/admin/routes.ts:203-218`). There is no user-level identity — anyone with the password gets full access. The Slack integration already exists for messaging (`src/index.ts:194-210`) but has no OAuth 2.0 consent flow. The issue requests adding a "Login with Slack" button alongside the existing password form, using the Arctic library for OAuth, with workspace-level restriction via `SLACK_ALLOWED_WORKSPACE`.

## Summary of Changes

1. **Backend**: Add Slack OAuth endpoints (`/oauth/slack/authorize`, `/oauth/slack/callback`) to the admin API routes, gated on optional env vars
2. **Backend**: Extend token creation to include a `method` field (`"password"` | `"slack"`)
3. **Backend**: Add a `/auth-config` or extend `/auth-required` to tell the frontend whether Slack OAuth is available
4. **Frontend**: Refactor `Login.tsx` to conditionally show a "Login with Slack" button alongside the password form
5. **Frontend**: Handle the OAuth callback redirect (extract token from URL, store it)
6. **Config**: Add new env vars to `.env.example` and `CLAUDE.md`

## Files to Modify

### Backend

#### `package.json` (root)
- **Add dependency**: `arctic` (OAuth 2.0 library with Slack provider support)

#### `src/admin/auth.ts` (lines 6-11, 13-31)
- **Extend `createToken`**: Accept optional `method: "password" | "slack"` parameter, include it in the token payload
- **Extend `verifyToken`**: Return the parsed payload (or at minimum, still validate correctly with the new field). Currently returns `boolean` — consider returning `{ valid: boolean; method?: string }` or keep it simple and just ensure the new payload field doesn't break validation
- **Add to auth middleware allowlist** (line 42): Let OAuth routes (`/oauth/slack/authorize`, `/oauth/slack/callback`) through without auth

#### `src/admin/routes.ts` (lines 187-218)
- **Extend `AdminConfig` interface** (line 11): Add optional `slackOAuthClientId`, `slackOAuthClientSecret`, `slackOAuthRedirectUri`, `slackAllowedWorkspace` fields
- **Extend `/auth-required` endpoint** (line 199): Return `{ required: boolean, slackOAuth: boolean }` so frontend knows whether to show the Slack button
- **Add `GET /oauth/slack/authorize`**: Create Arctic Slack provider instance, generate state parameter, store in cookie, redirect to Slack consent URL with scopes `openid,profile`
- **Add `GET /oauth/slack/callback`**: Validate state, exchange code for token via Arctic, call Slack `auth.test` or `openid.connect.userInfo` to get workspace ID, compare against `SLACK_ALLOWED_WORKSPACE`, reject if mismatch, create signed session token, redirect to `/admin?token=<token>`

#### `src/admin/index.ts` (line 13)
- No changes needed — `mountAdmin` passes config through; the new fields flow via `AdminConfig`

#### `src/index.ts` (lines 213-221)
- **Extend `mountAdmin` call**: Pass new Slack OAuth env vars into the `AdminConfig` object:
  - `slackOAuthClientId: process.env.SLACK_OAUTH_CLIENT_ID`
  - `slackOAuthClientSecret: process.env.SLACK_OAUTH_CLIENT_SECRET`
  - `slackOAuthRedirectUri: process.env.SLACK_OAUTH_REDIRECT_URI`
  - `slackAllowedWorkspace: process.env.SLACK_ALLOWED_WORKSPACE`

### Frontend

#### `dashboard/src/api.ts` (lines 204-206)
- **Extend `authRequired` response type**: `{ required: boolean; slackOAuth: boolean }`
- No new API methods needed (OAuth flow is browser redirects, not fetch calls)

#### `dashboard/src/components/Login.tsx` (entire file)
- **Accept new prop or fetch config**: Check if Slack OAuth is enabled via `api.authRequired()` response
- **Add "Login with Slack" button**: Links to `/admin/api/oauth/slack/authorize` (full page navigation, not fetch)
- **Layout**: Show password form and Slack button side-by-side or stacked with a divider ("or")
- **Loading state**: Show spinner if redirecting to Slack

#### `dashboard/src/App.tsx` (lines 337-370)
- **Handle OAuth callback**: On mount, check URL for `?token=` query parameter (set by callback redirect). If present, store token via `auth.setToken()`, strip param from URL, set auth state to `"ok"`
- **Pass `slackOAuth` flag** to `Login` component so it can conditionally render the button

### Config

#### `.env.example`
- Add section for Slack OAuth:
  ```
  # Slack OAuth (optional — enables "Login with Slack" on dashboard)
  # SLACK_OAUTH_CLIENT_ID=
  # SLACK_OAUTH_CLIENT_SECRET=
  # SLACK_OAUTH_REDIRECT_URI=http://localhost:8644/admin/api/oauth/slack/callback
  # SLACK_ALLOWED_WORKSPACE=your-workspace-domain
  ```

#### `CLAUDE.md` (Environment Variables section)
- Document the four new env vars

## Implementation Approach

### Step 1: Install Arctic dependency
```bash
npm install arctic
```

### Step 2: Backend — Auth module changes (`src/admin/auth.ts`)
- Extend `createToken` to accept and embed `method` in payload
- Add OAuth paths to the auth middleware allowlist
- Keep `verifyToken` return type as `boolean` (the `method` field is informational, not used for authorization decisions per the issue: "no user info surfaced")

### Step 3: Backend — OAuth routes (`src/admin/routes.ts`)
- Add `slackOAuth*` fields to `AdminConfig`
- Compute `slackOAuthEnabled` flag from presence of client ID + secret
- Add `GET /oauth/slack/authorize`:
  1. Generate random `state` string
  2. Set `state` in a short-lived HTTP-only cookie (for CSRF protection)
  3. Use Arctic's `Slack` provider to build the authorization URL
  4. Redirect the browser to Slack's OAuth consent screen
- Add `GET /oauth/slack/callback`:
  1. Read `state` from cookie, compare to `state` query param
  2. Use Arctic to exchange `code` for access token
  3. Call Slack API (`auth.test` with the user token, or `users.identity`) to get the workspace/team info
  4. Compare team domain against `SLACK_ALLOWED_WORKSPACE`; reject with 403 if mismatch
  5. Create signed token via `createToken(secret, "slack")`
  6. Redirect to `/admin?token=<token>`
- Extend `/auth-required` to return `slackOAuth: slackOAuthEnabled`

### Step 4: Backend — Wire env vars (`src/index.ts`)
- Pass the four new env vars into the `mountAdmin` config object

### Step 5: Frontend — Login UI (`Login.tsx`, `App.tsx`, `api.ts`)
- Update `api.authRequired` return type
- In `App.tsx`, on initial auth check, extract `?token=` from URL if present (OAuth callback redirect), store it, and skip to `"ok"` state. Pass `slackOAuth` to `Login`.
- In `Login.tsx`, conditionally render a "Login with Slack" button that navigates to `/admin/api/oauth/slack/authorize`

### Step 6: Config documentation
- Update `.env.example` and `CLAUDE.md`

### Step 7: Tests
- Add unit tests for the extended `createToken`/`verifyToken` with method field
- Add integration test for the OAuth callback with mocked Slack API response
- Verify existing password login tests still pass

## Risks and Edge Cases

1. **Arctic Slack provider compatibility**: Arctic's Slack provider must support the scopes needed (`openid`, `profile`). Verify Arctic exports a `Slack` class and what authorization URL format it produces. If Arctic doesn't have a Slack provider, fall back to manual OAuth (construct URLs and token exchange directly — Slack's OAuth is simple enough).

2. **Workspace validation**: The issue specifies `SLACK_ALLOWED_WORKSPACE` as a "team domain." Slack's `auth.test` returns `team` (name) and `team_id`. The `openid.connect.userInfo` endpoint returns team info differently. Need to decide: match on team domain string or team ID? Team ID is more reliable (domains can be renamed). Document which value to use.

3. **State/CSRF cookie**: The OAuth state parameter needs to survive the redirect round-trip. Using an HTTP-only, SameSite=Lax cookie is the standard approach. Hono supports `setCookie`/`getCookie` via `hono/cookie`.

4. **Token in URL**: After OAuth callback, redirecting to `/admin?token=<token>` briefly exposes the token in the browser URL bar and history. Mitigations: the App.tsx handler should strip the param immediately via `replaceState`. The token is short-lived (7 days) and equivalent to what's in localStorage anyway.

5. **Graceful degradation**: If `SLACK_OAUTH_CLIENT_ID` is not set, the Slack button must not appear. The `/auth-required` endpoint signals this. If `ADMIN_PASSWORD` is also empty, auth is disabled entirely (existing behavior preserved).

6. **Slack OAuth scopes**: The `openid` and `profile` scopes are Slack's "Sign in with Slack" scopes. These use `https://slack.com/openid/connect/authorize` (not `https://slack.com/oauth/v2/authorize`). Arctic may use the older OAuth v2 endpoint. If so, use `identity.basic` scope with `https://slack.com/oauth/v2/authorize` and `users.identity` API for workspace info.

7. **HTTPS requirement**: Slack OAuth requires HTTPS redirect URIs in production. Development can use `http://localhost`. Document this in the env var comments.

## Test Strategy

1. **Unit tests** (`src/admin/auth.test.ts` — new or extend existing):
   - `createToken(secret, "slack")` produces a valid token
   - `verifyToken` accepts tokens with `method` field
   - `verifyToken` still accepts tokens without `method` field (backward compat)

2. **Route tests** (`src/admin/routes.test.ts` — new or extend existing):
   - `GET /auth-required` returns `slackOAuth: false` when env vars missing
   - `GET /auth-required` returns `slackOAuth: true` when env vars present
   - `GET /oauth/slack/authorize` redirects to Slack with correct params
   - `GET /oauth/slack/callback` with valid code + matching workspace returns token redirect
   - `GET /oauth/slack/callback` with wrong workspace returns 403
   - `POST /login` (password) still works unchanged

3. **Frontend** (manual verification):
   - Login page shows only password form when Slack OAuth disabled
   - Login page shows both password form and Slack button when enabled
   - Clicking Slack button navigates to Slack consent
   - After Slack consent, redirect back stores token and shows dashboard
   - Password login still works independently

4. **Existing tests**: Run `npm test` to confirm no regressions (212 passing tests)

## Estimated Complexity

**Medium** — The OAuth flow is well-defined and the codebase has clean separation between auth, routes, and frontend. The main complexity is in correctly handling the OAuth callback (state validation, workspace verification, Slack API calls) and ensuring Arctic's Slack provider works as expected. No database schema changes, no new services, no architectural changes.
