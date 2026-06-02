# Guardrails report

Status: READY

Test/lint/build commands discovered and verified:

- Package manager (root): `npm` (from `package-lock.json`)
- Root scripts (from `package.json`):
  - Test: `npm test`
    - Underlying: `"vitest run"`
    - Status: Runner starts and all tests executed successfully (27 files, 467 tests passed, 1 todo).
  - Test (watch): `npm run test:watch`
    - Underlying: `"vitest"`
  - Build: `npm run build`
    - Underlying: `"tsc"`
  - Build all (server + dashboard): `npm run build:all`
    - Underlying: `"tsc && npm run build -w dashboard"`
  - Dashboard build: `npm run build:dashboard`
  - Dev server: `npm run dev:server`
  - Dev dashboard: `npm run dev:dashboard`
  - CLI: `npm run cli`
  - Dev (server + dashboard concurrently): `npm run dev`

No separate `lint` or `typecheck` scripts are defined; typechecking happens via `npm run build` (TypeScript `tsc`).
