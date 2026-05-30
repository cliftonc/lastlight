# Guardrails report

Status: BLOCKED (aborting build)

Test runner exists but currently fails to start; lint/typecheck commands are not configured.

- **Tests**
  - Framework: Vitest (`vitest.config.ts`, many `*.test.ts` files under `src/`).
  - Install: `npm install` (completed successfully, `vitest` present in `devDependencies` and `node_modules`).
  - Script: `"test": "vitest run"` in `package.json`.
  - Tried:
    - `npm test -- --help` → `sh: vitest: command not found` (npm script can’t find a `vitest` binary on PATH despite dependency; likely relying on `npx vitest` convention).
    - `npx vitest run src/config.test.ts --reporter basic` → Vitest CLI starts but errors with:
      - `CACError: Unknown option --runTestsByPath` (first attempt with Jest-style flag).
      - Then `Error: Failed to load custom Reporter from basic` (`--reporter basic` not accepted in this version/env).
  - Net: A test runner is configured but there is no currently working, known-good command that runs tests to completion in this sandbox. Recommended candidate for executor to try/fix: `npx vitest run` (no extra flags).

- **Linting**
  - No obvious linter config or script in `package.json` (`scripts` only cover `test`, `build`, `build:dashboard`, `build:all`, `start`, `dev`, `dev:server`, `dev:dashboard`, `cli`, `build:issue`, `test:watch`).
  - No `eslint`/`lint` script detected; no separate lint runner verified.
  - Status: **No configured lint command found.**

- **Type checking**
  - TypeScript present: `tsconfig.json`, `typescript` in `devDependencies`.
  - Script: `"build": "tsc"` (and `"build:all": "tsc && npm run build -w dashboard"`).
  - I did not run `npm run build` as part of this pre-flight (tests already blocked and the guardrails contract only requires confirming existence).
  - Status: **Typecheck command available** (recommended: `npm run build`).
