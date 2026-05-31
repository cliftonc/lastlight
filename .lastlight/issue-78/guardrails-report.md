# Guardrails report

Status: READY

Test/lint/typecheck commands discovered (root `package.json`):

- Test: `npm test`
  - Script: `"test": "vitest run"`
  - Verified: runner starts and prints Vitest help successfully.
- Watch tests: `npm run test:watch`
  - Script: `"test:watch": "vitest"`
- Build (TypeScript): `npm run build`
  - Script: `"build": "tsc"`
- Dashboard build: `npm run build:dashboard`
  - Script: `"build:dashboard": "npm run build -w dashboard"`
- All builds: `npm run build:all`
  - Script: `"build:all": "tsc && npm run build -w dashboard"`

Dashboard workspace (`dashboard/package.json`) has:

- Dev server: `npm run dev -w dashboard`
- Dashboard build: `npm run build -w dashboard`
- Preview: `npm run preview -w dashboard`

Caveats:

- No separate `lint` or standalone `typecheck` scripts are defined; typechecking is via `npm run build` and `dashboard`’s `build` script.
- Test suite behavior (pass/fail) wasn’t exercised; only that `npm test` correctly invokes Vitest.
