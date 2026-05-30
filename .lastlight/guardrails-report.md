# Guardrails report

Status: READY

Tests:
- Runner: vitest
- Command: `npm test` (alias for `vitest run`) — runs successfully, 27 files / 467 tests passed.

Lint:
- No lint script configured.
- Command tried: `npm run lint` → fails with `Missing script: "lint"`.

Type checking:
- TypeScript is configured (see `tsconfig.json`), but no dedicated script.
- Command tried: `npm run typecheck` → fails with `Missing script: "typecheck"`.
- For manual type checking, use: `npx tsc --noEmit` (or `npm run build` to compile).
