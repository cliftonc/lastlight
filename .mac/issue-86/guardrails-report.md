# Guardrails report

Status: READY

- Test command: `npm test` (defined in `package.json` "scripts")
- Runner: vitest v4.1.7
- Execution: Successfully started and ran all 468 tests (467 passed, 1 todo)
- No test framework or script was missing
- The runner executed tests and reported results

Commands found:
- `npm test` — test runner (uses `vitest run`)
- `npm run test:watch` — test runner in watch mode
- `npm run build` — type-check and compile (uses `tsc`)
- `npm run dev` — dev server and dashboard (uses `tsx watch src/index.ts`)
- `npm run dev:server` — server only (uses `tsx watch src/index.ts`)
- `npm run dev:dashboard` — dashboard only (uses `tsx watch src/index.ts`)

Caveats:
- The `test` script runs `vitest run` — no additional flags are needed.
- No `--runTestsByPath` or other custom flags were added; the command was used verbatim.
- All tests passed successfully, confirming the test runner is operational.
