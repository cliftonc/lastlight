# Executor Summary — Issue #31: Critical Security Fixes

## What Was Done

Replaced all shell-string `execSync` calls with array-based `execFileSync` / `execGit` helpers across 4 files, and changed the Docker sandbox prompt delivery from shell-interpolated argument to stdin.

## Files Changed

| File | Change |
|------|--------|
| `src/engine/git-auth.ts` | `execSync` → `execFileSync`; `exec(string)` → `execGit(args[])` |
| `src/worktree/manager.ts` | `execSync` → `execFileSync`; `exec(string)` → `execGit(args[])`; `execSync("mkdir -p …")` → `mkdirSync(…, {recursive:true})` |
| `src/sandbox/docker.ts` | Removed shell-escaping; changed claude invocation to `-p -`; added `-i` to docker exec args; changed `stdio[0]` from `"ignore"` to `"pipe"`; write prompt to `child.stdin` |
| `mcp-github-app/src/index.js` | `execSync` → `execFileSync` with array args for clone, credential.helper, user.name, user.email (both `clone_repo` and `refresh_git_auth` tools) |

### New Test Files

| File | Tests |
|------|-------|
| `src/engine/git-auth.test.ts` | 5 tests verifying no execSync calls, array args used, token not shell-quoted |
| `src/worktree/manager.test.ts` | 5 tests verifying no execSync calls, mkdirSync used, repoUrl as separate arg |
| `src/sandbox/docker.test.ts` | 5 tests verifying stdin pipe, prompt written to stdin, -i flag, -p - in cmd |

## Test Results

```
 Test Files  17 passed (17)
      Tests  290 passed | 1 todo (291)
   Start at  22:47:24
   Duration  2.87s (transform 416ms, setup 0ms, import 770ms, tests 324ms, environment 1ms)
```

## Lint Results

No linter configured (per guardrails report — not blocking).

## Typecheck Results

```
npx tsc --noEmit
(exits 0, no output)
```

## Deviations from Plan

None. All call sites listed in the plan were converted. The `ExecSyncOptions` import in `manager.ts` was changed to come from `child_process` alongside `execFileSync` (the type is compatible).
