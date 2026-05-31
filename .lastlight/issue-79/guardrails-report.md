# Guardrails report

Status: READY

Test/lint/typecheck commands discovered and verified:

- Package manager: npm (root `package-lock.json`)
- Root `package.json` scripts:
  - Test: `npm test`  
    - Underlying script: `"test": "vitest run"`  
    - Status: ✅ Runner starts and all tests passed in this run.
  - Watch tests: `npm run test:watch`  
    - Underlying: `"test:watch": "vitest"`
  - Build: `npm run build`  
    - Underlying: `"build": "tsc"`
  - Build all (server + dashboard): `npm run build:all`  
    - Underlying: `"build:all": "tsc && npm run build -w dashboard"`

- Dashboard workspace (`dashboard/package.json`):
  - Dev: `npm run dev -w dashboard`
  - Build: `npm run build -w dashboard`
  - Preview: `npm run preview -w dashboard`

Caveats/notes:
- Tests produce various informational log output (Slack, worktree, messaging migrations, etc.) but the suite is stable and completes successfully.
- No dedicated `lint` or `typecheck` scripts are defined; type checking occurs via `tsc` in the `build` scripts.
