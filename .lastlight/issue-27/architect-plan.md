# Architect Plan — Issue #27: GitHub OAuth login for admin dashboard

## Problem Statement

The admin dashboard (`src/admin/routes.ts`) currently supports password auth (`routes.ts:213-228`) and Slack OAuth (`routes.ts:231-320`), but has no GitHub-based login. Teams whose identity is centered on a GitHub organization are forced to share a static `ADMIN_PASSWORD` or set up Slack OAuth they would not otherwise need. The fix is to add a third method — "Login with GitHub" — that mirrors the existing Slack OAuth flow using the same `arctic` library (`GitHub` class is already on disk at `node_modules/arctic/dist/providers/github.d.ts` and exposes an identical `createAuthorizationURL` / `validateAuthorizationCode` API). An optional `GITHUB_ALLOWED_ORG` restricts login to members of a named GitHub organization via a `GET /orgs/{org}/members/{login}` membership probe that only accepts a `204`.

## Summary of Changes

1. Widen `createToken` method union in `src/admin/auth.ts:6` to include `"github"`, and add the two new OAuth paths to the `authMiddleware` bypass list (`src/admin/auth.ts:43-49`).
2. Add four `github*` fields to `AdminConfig` in `src/admin/routes.ts:13-28`, a `githubOAuthEnabled` feature flag (mirroring `slackOAuthEnabled` at `routes.ts:203`), include it in `/auth-required` (`routes.ts:209-211`), and add two new routes `GET /oauth/github/authorize` and `GET /oauth/github/callback` that copy the Slack pattern but use `GET /user` and (optionally) `GET /orgs/{org}/members/{login}` instead of `openid.connect.userInfo`.
3. Wire the four new env vars into the `mountAdmin` call in `src/index.ts:214-222`, and add commented-out examples to `.env.example` (after the Slack OAuth block at `.env.example:20-26`).
4. Update the React login page: add a `githubOAuth` prop to `Login` (`dashboard/src/components/Login.tsx`), add the state and read it from `/auth-required` in `App.tsx:321-344`, and widen the `authRequired` return type in `dashboard/src/api.ts:205`.
5. Extend `src/admin/routes.test.ts` with a `GitHub` class in the `arctic` mock and the full set of tests mirroring the existing Slack ones.

## Files to Modify

### `src/admin/auth.ts`

- **Line 6** — widen `method?: "password" | "slack"` to `method?: "password" | "slack" | "github"`.
- **Lines 43-49** — add two more conditions to the bypass list:
  ```typescript
  path.endsWith("/oauth/github/authorize") ||
  path.endsWith("/oauth/github/callback")
  ```

### `src/admin/routes.ts`

- **Line 6** — import `GitHub` alongside `Slack`: `import { Slack, GitHub } from "arctic";`.
- **Lines 22-27 (`AdminConfig`)** — add after `slackAllowedWorkspace`:
  ```typescript
  /** GitHub OAuth config (optional — enables "Login with GitHub" on dashboard) */
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  githubOAuthRedirectUri?: string;
  /** Restrict login to members of this GitHub organization (requires read:org scope) */
  githubAllowedOrg?: string;
  ```
- **After line 203** — add a parallel feature flag:
  ```typescript
  const githubOAuthEnabled = Boolean(config.githubOAuthClientId && config.githubOAuthClientSecret);
  ```
- **Line 210** — extend the `/auth-required` response:
  ```typescript
  return c.json({
    required: Boolean(config.adminPassword),
    slackOAuth: slackOAuthEnabled,
    githubOAuth: githubOAuthEnabled,
  });
  ```
- **After the Slack callback (after line 320)** — add two new handlers. Shape:
  - `GET /oauth/github/authorize`: 404 when disabled; otherwise `new GitHub(clientId, secret, redirectUri ?? "")`, `randomBytes(16).toString("hex")` state, `setCookie(c, "github_oauth_state", state, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 600 })`, `github.createAuthorizationURL(state, ["read:user", "read:org"])`, 302.
  - `GET /oauth/github/callback`: 404 when disabled; read+delete `github_oauth_state` cookie; reject mismatch with 400; require `code`; `github.validateAuthorizationCode(code)`; `tokens.accessToken()`; `fetch("https://api.github.com/user", { headers: { Authorization: \`Bearer ${accessToken}\`, "User-Agent": "lastlight-admin", Accept: "application/vnd.github+json" } })`; parse `{ login }`; when `config.githubAllowedOrg` is set, `fetch(\`https://api.github.com/orgs/${org}/members/${login}\`, …)` — accept ONLY `204`; everything else (302, 404, 401) → 403 `org membership required`; on success `createToken(config.adminSecret, "github")` and 302 to `/admin/?token=…`.

### `src/index.ts`

- **Lines 219-222** — extend the `mountAdmin` config after `slackAllowedWorkspace`:
  ```typescript
  githubOAuthClientId: process.env.GITHUB_OAUTH_CLIENT_ID,
  githubOAuthClientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
  githubOAuthRedirectUri: process.env.GITHUB_OAUTH_REDIRECT_URI,
  githubAllowedOrg: process.env.GITHUB_ALLOWED_ORG,
  ```

### `.env.example`

- **After line 26** — add:
  ```
  # ── GitHub OAuth (optional — enables "Login with GitHub" on dashboard) ──
  # Uses the existing GitHub App's OAuth capability. Client ID is shown on the
  # App settings page; generate a client secret in the same page under
  # "Client secrets". Redirect URI must be:
  # https://<your-host>/admin/api/oauth/github/callback
  # GITHUB_OAUTH_CLIENT_ID=
  # GITHUB_OAUTH_CLIENT_SECRET=
  # GITHUB_OAUTH_REDIRECT_URI=http://localhost:8644/admin/api/oauth/github/callback
  # GITHUB_ALLOWED_ORG=              # Restrict to org members (requires read:org)
  ```

### `dashboard/src/api.ts`

- **Line 205** — widen the `authRequired` return type:
  ```typescript
  authRequired: () => req<{ required: boolean; slackOAuth: boolean; githubOAuth: boolean }>("/auth-required"),
  ```

### `dashboard/src/components/Login.tsx`

- **Lines 4-7** — add `githubOAuth?: boolean;` to `Props`.
- **Line 9** — destructure `githubOAuth` in signature.
- **Line 13** — add `const [githubRedirecting, setGithubRedirecting] = useState(false);`.
- **After `handleSlackLogin` (line 33)** — add `handleGithubLogin` that redirects to `/admin/api/oauth/github/authorize`.
- **Lines 44-56** — render the GitHub button under the Slack button, reusing the `btn btn-outline btn-sm w-full` style and keeping a single `divider` between the OAuth group and the password form. Order: Slack first (existing), GitHub second. Only render the divider when at least one OAuth button is present.

### `dashboard/src/App.tsx`

- **Line 321** — add `const [githubOAuth, setGithubOAuth] = useState(false);`.
- **Line 338** — destructure `githubOAuth` from `api.authRequired()` and call `setGithubOAuth(...)` the same way `slackOAuth` is handled.
- **Line 374** — pass `githubOAuth={githubOAuth}` to `<Login>`.

### `src/admin/routes.test.ts`

- **Lines 14-24 (arctic mock)** — add a `GitHub` class alongside `Slack`:
  ```typescript
  class GitHub {
    createAuthorizationURL(_state: string, _scopes: string[]) {
      return new URL("https://github.com/login/oauth/authorize?mocked=1");
    }
    async validateAuthorizationCode(_code: string) {
      return { accessToken: () => "mock-github-access-token" };
    }
  }
  return { Slack, GitHub };
  ```
- **New describe block** — mirror the Slack test suite:
  - `/auth-required` returns `githubOAuth: false` when not configured.
  - `/auth-required` returns `githubOAuth: true` when client ID and secret are set.
  - `GET /oauth/github/authorize` returns 404 when not configured; redirects to github.com when configured.
  - `GET /oauth/github/callback` returns 404 when not configured; 400 on state mismatch.
  - `GET /oauth/github/callback` rejects non-org member with 403 when `githubAllowedOrg` is set (mock `fetch` for `/user` returning 200 `{ login: "alice" }`, then for `/orgs/acme/members/alice` returning 404).
  - `GET /oauth/github/callback` succeeds (302 with `?token=`) when org membership returns 204.
  - `GET /oauth/github/callback` succeeds without org check when `githubAllowedOrg` is unset.

  Use a helper `mockGithubFetch({ userLogin, orgStatus })` that returns a `vi.fn()` whose responses are routed by URL — mirrors the `global.fetch = vi.fn(...)` pattern at `routes.test.ts:135-143`.

## Implementation Approach

1. **Types and auth first.** Widen the `createToken` method union and the `authMiddleware` bypass list in `src/admin/auth.ts`. These are two-line edits but they unblock the rest.
2. **Config plumbing.** Extend `AdminConfig`, add the `githubOAuthEnabled` flag, extend `/auth-required`. Typecheck before moving on.
3. **Authorize route.** Add `GET /oauth/github/authorize` — the simplest handler. Mirror the Slack one line-for-line, swapping `Slack` → `GitHub`, `slack_oauth_state` → `github_oauth_state`, scopes `["openid","profile"]` → `["read:user","read:org"]`.
4. **Callback route.** Add `GET /oauth/github/callback`. Key differences from the Slack callback:
   - User identity comes from `GET https://api.github.com/user` (not `openid.connect.userInfo`). Headers must include `Authorization: Bearer …`, `User-Agent` (GitHub requires one), and `Accept: application/vnd.github+json`.
   - Membership check: `GET /orgs/{org}/members/{login}` — only `204` passes. Both `302` (caller only has public visibility) and `404` (not a member) reject. Do NOT follow the redirect.
   - URL-encode `{org}` and `{login}` when building the membership URL.
   - Issue token with `createToken(config.adminSecret, "github")` and 302 to `/admin/?token=…` (same pattern as Slack at `routes.ts:311-315`).
5. **Env wiring.** Add the four `GITHUB_OAUTH_*` / `GITHUB_ALLOWED_ORG` pass-throughs in `src/index.ts`. Update `.env.example`.
6. **Frontend.** Update `dashboard/src/api.ts` type, add state in `App.tsx`, add prop and button in `Login.tsx`. Keep the button style identical to Slack; do not add GitHub-specific styling in this PR (deferred per the issue's "out of scope").
7. **Tests.** Extend the arctic mock with the `GitHub` class, then add the test cases. Mock `fetch` per-test using the same pattern already in `routes.test.ts:135-143`, routing by URL so `/user` and `/orgs/.../members/...` return different responses.
8. **Verify.** `npx tsc --noEmit` in repo root, `cd dashboard && npx tsc -b`, `npx vitest run src/admin/routes.test.ts`, then full `npm test`.

## Risks and Edge Cases

- **User-Agent header.** GitHub's REST API rejects requests with no `User-Agent` (403 with `User-Agent strongly encouraged`). The existing Slack code does not set one. Set `User-Agent: "lastlight-admin"` explicitly on every `api.github.com` call.
- **Membership 302 vs 404.** `GET /orgs/{org}/members/{username}` returns `302` when the caller lacks the `read:org` scope or is not a member with visibility — not just `404`. The spec says "only `204` is accepted" — implement that literally. Use `fetch(..., { redirect: "manual" })` to avoid `fetch` silently following the 302 to the public profile.
- **User login URL-encoding.** GitHub logins are case-insensitive ASCII with hyphens, but still template them via `encodeURIComponent` to avoid accidental injection if the `/user` response is ever spoofed in tests.
- **Missing `login` in `/user` response.** If the response body has no `login` field (network blip, revoked token, HTML error page), 502 with `"GitHub userInfo failed"`. Mirrors how the Slack path handles `userInfo.ok === false` (`routes.ts:290-293`).
- **arctic `GitHub` constructor** accepts `redirectURI: string | null`. The Slack code passes `slackOAuthRedirectUri ?? ""`; use the same pattern — empty string is treated as "use app default", matching Slack.
- **Path matching in `authMiddleware`.** Each OAuth path is matched via `.endsWith()`. Two new entries is consistent with the existing shape; no regex needed.
- **`/auth-required` backwards compatibility.** Older dashboard bundles expect only `{ required, slackOAuth }`. Adding `githubOAuth` is additive; existing clients ignore unknown keys. No breaking change.
- **Feature flag asymmetry.** `githubOAuthEnabled` intentionally does not require `githubAllowedOrg` — the feature must work without an org restriction (per acceptance criteria "When `GITHUB_ALLOWED_ORG` is not set, any authenticated GitHub user can log in").
- **Shared GitHub App credentials.** The issue specifies reusing the existing GitHub App's OAuth, but the App ID / PEM / webhook secret are separate from the OAuth `client_id` / `client_secret`. This plan keeps them distinct env vars to avoid coupling.
- **Token URL leakage.** Redirecting to `/admin/?token=…` puts the session token in the browser history. The existing Slack flow accepts this; `App.tsx:328-336` immediately `replaceState`s to strip it. No change needed — the logic is provider-agnostic.

## Test Strategy

Unit tests (vitest, `src/admin/routes.test.ts`):

1. `/auth-required` returns `githubOAuth: false` by default; `true` when both id+secret set; `false` when only id set.
2. `GET /oauth/github/authorize` — 404 when unset; 302 with `location` containing `github.com` when set; verifies `github_oauth_state` cookie is set with `httpOnly; SameSite=Lax; Path=/`.
3. `GET /oauth/github/callback` — 404 when unset; 400 on state mismatch; 400 on missing code.
4. `GET /oauth/github/callback` — happy path without org restriction: mock `fetch` for `/user` → `{ login: "alice" }`; expect 302 to `/admin/?token=…`.
5. `GET /oauth/github/callback` — org restriction: mock `/user` → `alice`; `/orgs/acme/members/alice` → 204 → 302 success.
6. `GET /oauth/github/callback` — org restriction rejects non-member: `/orgs/acme/members/alice` → 404 → 403 with `"org membership required"`.
7. `GET /oauth/github/callback` — org restriction rejects 302 (public-only): → 403.
8. Existing Slack tests continue to pass (no regression from extended `arctic` mock).
9. Existing password `/login` tests continue to pass (`routes.test.ts:222-248`).

Manual verification (post-merge, not part of PR acceptance):
- Configure a dev GitHub App with `http://localhost:8644/admin/api/oauth/github/callback` as an OAuth callback URL; set env vars; `npm run dev`; visit `/admin/`, click "Login with GitHub", confirm redirect chain and token issuance.

Guardrails:
- `npx tsc --noEmit` (root) must pass.
- `cd dashboard && npx tsc -b` must pass.
- `npm test` — expect 231 → 231+N (at least 8 new tests) passing, no regressions.

## Estimated Complexity

**Medium.** The code shape is almost a direct copy of the existing Slack OAuth path — the arctic API is identical, the cookie/state pattern is identical, the token+redirect is identical — but there are three substantive differences that make this more than a rename: (1) the user identity fetch uses GitHub's `/user` endpoint with GitHub-specific headers; (2) the org membership check has subtle status-code semantics (`204` yes, `302`/`404` no) that require `redirect: "manual"`; (3) the test mock needs per-URL routing to exercise both `/user` and `/orgs/.../members/...` in the same test. Roughly 150–200 lines of new code + tests, spread across 7 files.
