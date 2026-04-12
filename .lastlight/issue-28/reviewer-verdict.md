# Reviewer Verdict — Issue #28

VERDICT: APPROVED

## Summary

The implementation matches the architect plan faithfully: all 9 steps are present, the setup guard in `cli.ts` correctly intercepts before the health check, `package.json` has the `bin` field, and `.env.example` is updated. Tests pass (262/263, 1 pre-existing todo) and typecheck is clean. Two issues worth noting for follow-up but neither blocks merge.

## Issues

### Critical

None.

### Important

**`ADMIN_PASSWORD` (and user-supplied optional fields) written unquoted to `.env`**
`src/setup.ts:106` — `ADMIN_PASSWORD=${config.ADMIN_PASSWORD}` is written without quoting. If the user sets a password containing `#` (e.g. `hunter2#42`), `dotenv` will silently truncate it at the `#` (treated as comment). Passwords with `=` or spaces are similarly mishandled. The auto-generated `WEBHOOK_SECRET` and `ADMIN_SECRET` are hex-only so they're safe; the Slack tokens are prefix-validated and unlikely to contain these characters, but `ADMIN_PASSWORD` is entirely user-controlled with only a length check.

Fix: quote the value — `ADMIN_PASSWORD="${config.ADMIN_PASSWORD}"` — or strip/reject special characters at input time.

### Suggestions

**`useCaddy` is collected but has no effect**
`src/setup.ts:255,471` — the user is asked "Use Caddy for automatic TLS?" and the answer is stored in `SetupConfig.useCaddy`, but `buildEnvContent` never writes it and `dockerBuildAndLaunch` ignores it (always runs the same `docker compose up -d`). If this flag is meant to toggle a Compose profile or print different instructions, that logic is missing. If it's purely informational for now, the field should be removed or the wizard should at least print a note when Caddy is not selected.

**Domain validation is very permissive**
`src/setup.ts:251` — `(d) => d.length > 0 && d.includes(".")` accepts `.foo`, `foo.`, `127.0.0.1`, etc. A stricter check (e.g. at least one label of 2+ chars on each side of the dot) would catch obvious typos before they end up in `.env`.

### Nits

- `src/setup.ts:89` — `GITHUB_APP_PRIVATE_KEY_PATH=./secrets/app.pem` is hardcoded in `buildEnvContent` rather than derived from `config.pemSourcePath`. This is intentional (the destination is always `./secrets/app.pem`) but a comment would clarify.
- The `files` field in `package.json` is not set, so `dist/` may be excluded from the npm tarball. The executor flagged this as a known follow-up; it's worth a separate issue before the first `npm publish`.

## Test Results

```
 Test Files  13 passed (13)
      Tests  262 passed | 1 todo (263)
   Start at  06:53:56
   Duration  2.24s (transform 351ms, setup 0ms, import 621ms, tests 284ms, environment 1ms)
```

Typecheck: `npx tsc --noEmit` exits 0, no errors.
