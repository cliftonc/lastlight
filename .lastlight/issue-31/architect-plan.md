# Architect Plan — Issue #31: Critical Security Fixes

## Problem Statement

Three critical command injection vulnerabilities exist in the codebase. In `src/engine/git-auth.ts:67-68`, the credential helper embeds a token directly into a shell string passed to `execSync()` — a token containing shell metacharacters could execute arbitrary commands. In `src/worktree/manager.ts:29-31,63`, the `exec()` helper passes all git commands as shell strings to `execSync()`, allowing injection via `repoUrl`, `branch`, `bareDir`, or `worktreePath`. In `src/sandbox/docker.ts:179-190`, the agent prompt is shell-escaped with a fragile single-quote replacement and passed as a `sh -c` argument — crafted issue bodies (which flow directly into prompts) can break the shell boundary. Additionally, `mcp-github-app/src/index.js:94,100-101` uses `execSync` with `.join(" ")` and string interpolation for git clone and config commands.

## Summary of Changes

1. **git-auth.ts**: Replace shell-string `execSync()` calls with `execFileSync()` array-based invocations.
2. **worktree/manager.ts**: Replace the `exec()` shell-string helper with an `execFile()`-based helper. Convert all git command constructions from string interpolation to argument arrays.
3. **docker.ts**: Pass the prompt via stdin to the `sh -c` command instead of embedding it in the command line.
4. **mcp-github-app/src/index.js**: Replace `execSync(array.join(" "))` with `execFileSync(cmd, args)` for clone and config commands.

## Files to Modify

### 1. `src/engine/git-auth.ts` (lines 1, 67-68, 106-107, 165-167)

**Current (line 165-167):**
```typescript
function exec(cmd: string): void {
  execSync(cmd, { stdio: "pipe" });
}
```

**Change:**
- Replace `exec()` helper with `execFile()` that takes a command + args array.
- Refactor all call sites (lines 68, 72, 73, 107) to pass arguments as arrays:
  - `git config --global credential.helper <value>` → `execFileSync("git", ["config", "--global", "credential.helper", credHelper])`
  - `git config --global user.name <value>` → `execFileSync("git", ["config", "--global", "user.name", value])`
  - `git config --global user.email <value>` → `execFileSync("git", ["config", "--global", "user.email", value])`
- Import `execFileSync` instead of `execSync`.

### 2. `src/worktree/manager.ts` (lines 1, 29-31, 53, 63, 66, 76, 85-86, 90, 125, 132, 140)

**Current (line 29-31):**
```typescript
private exec(cmd: string, opts?: ExecSyncOptions): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }) as string;
}
```

**Change:**
- Replace `exec(cmd: string)` with `execGit(args: string[], opts?)` that calls `execFileSync("git", args, ...)`.
- Convert every call site from string interpolation to argument arrays:
  - Line 53: `mkdir -p` → use `mkdirSync` with `{ recursive: true }` (no shell needed)
  - Line 63: `git clone --bare ${repoUrl} ${bareDir}` → `execGit(["clone", "--bare", repoUrl, bareDir])`
  - Line 66: `git -C ${bareDir} fetch --all --prune` → `execGit(["-C", bareDir, "fetch", "--all", "--prune"])`
  - Line 76: `git -C ${bareDir} rev-parse --verify origin/${branch}` → `execGit(["-C", bareDir, "rev-parse", "--verify", \`origin/${branch}\`])`
  - Line 85: `git -C ${bareDir} worktree add ${worktreePath} origin/${branch}` → `execGit(["-C", bareDir, "worktree", "add", worktreePath, \`origin/${branch}\`])`
  - Line 86: `git -C ${worktreePath} checkout -B ${branch} origin/${branch}` → `execGit(["-C", worktreePath, "checkout", "-B", branch, \`origin/${branch}\`])`
  - Line 90: `git -C ${bareDir} worktree add -b ${branch} ${worktreePath} ${baseRef}` → `execGit(["-C", bareDir, "worktree", "add", "-b", branch, worktreePath, baseRef])`
  - Line 125: `git -C ${bareDir} worktree remove --force ${info.path}` → `execGit(["-C", bareDir, "worktree", "remove", "--force", info.path])`
  - Line 132: `git -C ${bareDir} worktree prune` → `execGit(["-C", bareDir, "worktree", "prune"])`
  - Line 140: `git -C ${bareDir} branch -D ${info.branch}` → `execGit(["-C", bareDir, "branch", "-D", info.branch])`
- Import `execFileSync` instead of `execSync`, add `mkdirSync` to the `fs` import.

### 3. `src/sandbox/docker.ts` (lines 179-190)

**Current (lines 179-190):**
```typescript
const escapedPrompt = prompt.replace(/'/g, "'\\''");
const cmd = [
  "claude",
  "--print", "--verbose",
  "--dangerously-skip-permissions",
  "--output-format", "stream-json",
  "--model", model,
  "-p", `'${escapedPrompt}'`,
].join(" ");
const args = ["exec", "--user", "agent", "-w", WORKSPACE_DIR, info.containerName, "sh", "-c", cmd];
```

**Change:**
- Pass the prompt via stdin instead of as a shell argument.
- Remove the shell escaping entirely.
- Build the docker exec command to pipe stdin:
  ```typescript
  const cmd = ["claude", "--print", "--verbose", "--dangerously-skip-permissions",
    "--output-format", "stream-json", "--model", model, "-p", "-"].join(" ");
  const args = ["exec", "-i", "--user", "agent", "-w", WORKSPACE_DIR,
    info.containerName, "sh", "-c", cmd];
  ```
- Change the `spawn` call (line 193) from `stdio: ["ignore", "pipe", "pipe"]` to `stdio: ["pipe", "pipe", "pipe"]`, then write the prompt to `child.stdin` and close it.

### 4. `mcp-github-app/src/index.js` (lines 6, 94, 100-101, 105-106, 132)

**Current (line 94):**
```javascript
execSync(["git", "clone", ...branchArgs, url, dest].join(" "), { ... });
```

**Change:**
- Import `execFileSync` alongside `execSync` (or replace entirely).
- Line 94: `execSync(array.join(" "))` → `execFileSync("git", ["clone", ...branchArgs, url, dest], { ... })`
- Line 100-101: `execSync(\`git -C ${dest} config credential.helper '${credHelper}'\`)` → `execFileSync("git", ["-C", dest, "config", "credential.helper", credHelper], { ... })`
- Line 104: `execSync(\`git -C ${dest} config user.name "..."\`)` → `execFileSync("git", ["-C", dest, "config", "user.name", "last-light[bot]"], { ... })`
- Line 105-106: Same pattern for `user.email`.
- Line 132: `execSync(\`git -C ${repoPath} config credential.helper '${credHelper}'\`)` → `execFileSync("git", ["-C", repoPath, "config", "credential.helper", credHelper], { ... })`

## Implementation Approach

### Step 1: Fix `src/engine/git-auth.ts`
1. Change import from `execSync` to `execFileSync`.
2. Replace the `exec()` helper with a new `execGit()` that takes an args array.
3. Refactor all 4 call sites (lines 68, 72, 73, 107) to use argument arrays.
4. Verify: `npx tsc --noEmit` passes.

### Step 2: Fix `src/worktree/manager.ts`
1. Change import from `execSync` to `execFileSync`.
2. Add `mkdirSync` to `fs` imports.
3. Replace `exec()` with `execGit()` taking an args array.
4. Convert all 10 call sites from string interpolation to argument arrays.
5. Replace `execSync(\`mkdir -p ...\`)` with `mkdirSync(..., { recursive: true })`.
6. Verify: `npx tsc --noEmit` passes.

### Step 3: Fix `src/sandbox/docker.ts`
1. Remove the `escapedPrompt` shell-escaping logic.
2. Change the claude CLI invocation to read the prompt from stdin (`-p -`).
3. Add `-i` flag to docker exec args so stdin is connected.
4. Change spawn stdio from `["ignore", ...]` to `["pipe", ...]`.
5. After spawn, write `prompt` to `child.stdin` and call `child.stdin.end()`.
6. Verify: `npx tsc --noEmit` passes.

### Step 4: Fix `mcp-github-app/src/index.js`
1. Add `execFileSync` to the import from `child_process`.
2. Convert all 5 `execSync` call sites in clone_repo and refresh_git_auth to `execFileSync` with argument arrays.
3. Verify: the file parses correctly (no TypeScript here, it's plain JS).

### Step 5: Verify
1. `npx tsc --noEmit` — full typecheck.
2. `npx vitest run` — all 275 existing tests still pass.
3. Manual review of each changed file to confirm no regression in argument ordering.

## Risks and Edge Cases

1. **`claude -p -` (stdin mode)**: Must verify that the Claude CLI supports `-p -` for reading the prompt from stdin. If not, an alternative is `--prompt-file /dev/stdin` or passing the prompt via an environment variable (`-e PROMPT=...` on docker exec, then `claude -p "$PROMPT"` in the shell command). The environment variable approach avoids both shell escaping and stdin complexity.
   - **Fallback**: Use `docker exec -e PROMPT=... sh -c 'claude ... -p "$PROMPT"'`. Environment variables don't pass through the shell parser, so this is injection-safe.

2. **Token content**: Installation tokens from GitHub are opaque strings (e.g., `ghs_...`). They shouldn't contain shell metacharacters in practice, but the fix is still correct — defense in depth.

3. **Branch names with special characters**: Git branch names can contain `/` and `-` but not most shell metacharacters. The `execFileSync` approach handles this correctly regardless.

4. **Worktree path construction**: Paths are constructed from `taskId` which comes from internal generation (UUID-based). Still, `execFileSync` protects against any future change in taskId format.

5. **`repoUrl` validation**: The issue mentions validating against an allowlist of hosts. This is defense-in-depth beyond the critical injection fix. The `repoUrl` in the worktree manager comes from internal routing logic, not directly from user input. The `execFileSync` change eliminates the injection vector; host validation can be a follow-up.

6. **Backward compatibility of mcp-github-app**: The `execFileSync` change is a drop-in replacement for `execSync(array.join(" "))` — same semantics, no shell interpretation. No API changes.

## Test Strategy

1. **Existing test suite**: Run `npx vitest run` to confirm no regressions (275 tests).
2. **Type checking**: Run `npx tsc --noEmit` to confirm all types are correct.
3. **New unit tests**: Add tests for:
   - `git-auth.ts`: Mock `execFileSync` and verify argument arrays are correct.
   - `worktree/manager.ts`: Mock `execFileSync` and verify all git commands use argument arrays (no shell string construction).
   - `docker.ts`: Verify that `runAgent` writes the prompt to stdin and doesn't embed it in the command line.
4. **Manual verification**: Review each diff to confirm no argument ordering errors.

## Estimated Complexity

**Medium** — The changes are conceptually simple (replace string-based exec with array-based execFile) but touch 4 files across 2 packages with ~20 individual call sites. The docker.ts stdin change requires modifying the spawn flow. No architectural changes, no new dependencies, no API changes.
