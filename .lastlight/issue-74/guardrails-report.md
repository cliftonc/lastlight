# Guardrails report

Status: BLOCKED (aborting build)

Test framework:
- Intended runner: `vitest` via `npm test` (`"test": "vitest run"` in package.json).
- Current status: `npm test` fails with `sh: vitest: command not found` because dependencies are not installed in this checkout.
- To enable tests: run `npm install` once, then use:
  - Test command: `npm test`
  - Watch mode: `npm run test:watch`

Linting:
- No `lint` script in `package.json` (`npm run lint` fails: “Missing script: "lint"`).
- Conclusion: No project-level lint command is configured.

Type checking:
- No `typecheck` script in `package.json` (`npm run typecheck` fails: “Missing script: "typecheck"`).
- There is a `build` script using `tsc`:
  - Typecheck/build command: `npm run build`
- `npm run build` was not executed in this pre-flight, but it is the correct command to run TypeScript checks.
