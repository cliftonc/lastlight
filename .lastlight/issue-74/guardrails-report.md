# Guardrails report

Status: BLOCKED (aborting build)

Test framework:
- Runner: Vitest
- Command: `npm test` (alias for `vitest run`)
- Status: PASSED — all 28 test files (473 tests, 1 todo) completed successfully.

Linting:
- No lint script defined in `package.json`.
- Command tried: `npm run lint`
- Status: BROKEN — fails with `Missing script: "lint"`.

Type checking:
- No root typecheck script defined in `package.json`.
- Command tried: `npm run typecheck`
- Status: BROKEN — fails with `Missing script: "typecheck"`.

Summary:
- Usable test command: **yes** → `npm test`
- Project-level lint and typecheck commands: **absent**, so cannot be run via npm scripts.
