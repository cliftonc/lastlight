Guardrails check for issue #98

Summary:
- Test framework: Vitest present (devDependency) and many test files exist under src/ and dashboard/. Local `npm run test` fails in this environment because devDependencies are not installed; CI uses `npm ci` and runs `npx vitest run` successfully.
- Linting: No explicit linter configuration detected (no .eslintrc, ruff, or similar). Repository relies on TypeScript strict checks and tests; linter is informational.
- Type checking: TypeScript configured (tsconfig.json). CI runs `tsc --noEmit` and dashboard build.
- CI pipeline: .github/workflows/ci.yml exists and runs install, typecheck, and tests.

Notes:
- This environment does not have devDependencies installed, so running tests locally with `npm run test` failed (vitest: not found). In CI the commands in .github/workflows/ci.yml install dependencies and run tests.

Conclusion: All critical guardrails (test runner, typecheck, CI) are present. Linting is not configured as a hard guardrail here.
