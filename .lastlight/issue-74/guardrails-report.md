# Guardrails report

Status: READY

Test / lint / typecheck status for this checkout of `cliftonc/lastlight`:

- Tests
  - Framework: Vitest
  - Command: `npm test`
  - Status: Passes
  - Notes: 27 test files, 467 tests passed, 1 todo.

- Type checking / build
  - Tool: TypeScript compiler
  - Command: `npm run build` (runs `tsc`)
  - Status: Succeeds

- Linting
  - No lint script is defined in `package.json`.
  - Commands attempted:
    - `npm run lint` → fails with “Missing script: \"lint\"”.
    - `npm run lint:fix` → fails with “Missing script: \"lint:fix\"”.
  - Conclusion: No project-level linter command is configured.
