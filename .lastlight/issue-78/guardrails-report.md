# Guardrails report

Status: READY

Test runner:
- Detected package manager: npm (package-lock.json present).
- Test command: `npm test`
  - Underlying script: `"test": "vitest run"` (from root `package.json`).
  - Status: Runner starts and executes the full Vitest suite successfully (all tests passed).

Other useful commands (from root `package.json`):
- Build: `npm run build`
  - `"build": "tsc"`
- Build dashboard: `npm run build:dashboard`
  - `"build:dashboard": "npm run build -w dashboard"`
- Build all: `npm run build:all`
  - `"build:all": "tsc && npm run build -w dashboard"`
- Dev server + dashboard: `npm run dev`
  - `"dev": "concurrently -n server,dash -c blue,magenta \"bash scripts/dev-local.sh\" \"npm run dev -w dashboard\""`
- Dev server only: `npm run dev:server`
- Dev dashboard only: `npm run dev:dashboard`
- CLI: `npm run cli`
- Issue builder: `npm run build:issue`
- Test watch: `npm run test:watch`
  - `"test:watch": "vitest"`

Caveats:
- Tests invoke Vitest directly and exercise Git, Slack, and messaging abstractions, but in this run they all passed in the current sandbox. The executor should continue to use `npm test` without extra flags.
