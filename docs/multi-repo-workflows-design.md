# Multi-Repo Workflows — Design Doc

## Context

Today every Last Light workflow run operates on **exactly one repo**. A
single `owner`/`repo` pair is threaded from the trigger all the way down to
the sandbox: the GitHub App token is scoped to it, one checkout is cloned into
the workspace, the agent's cwd is that checkout, and prompts/build-assets are
keyed by it.

We want a workflow (e.g. an architect/build cycle) to be able to **check out
two or more connected repos into one workspace** and work across them — e.g.
a change that spans an API repo and its client SDK, or a shared library and a
consumer.

**Decisions taken** (from clarifying questions):
- **Repo selection: explicit at trigger time** — the caller names the extra
  repo(s), e.g. `lastlight build owner/repo#N --with owner/other`. Nothing
  auto-attaches from config.
- **Write scope: write to all** — the agent may branch/commit/PR in every
  attached repo, not just the primary.
- **Output: design doc only** — no code yet. This file is the deliverable.

Throughout, the repo the issue/PR lives on stays the **primary** (anchors the
trigger id, build branch, build-asset key, artifact URLs); the extra repos are
**secondary** but equally writable.

## Why this fits the existing architecture

Two existing facts make this far cheaper than it looks:

1. **The GitHub App token already supports multiple repos.** `git-auth.ts`'s
   `configureGitAuth({ repositories?: string[] })` and `getInstallationToken`
   pass `repositories` straight to GitHub's installation-token API
   (`src/engine/git-auth.ts:101`, `:194`). Today `prepareRun` just populates it
   with a single element: `const repositories = access.repo ? [access.repo] : undefined;`
   (`src/engine/agent-executor.ts:264`). One token scoped to N repos is a
   built-in capability — we only need to feed it the list.

2. **The workspace already clones into `<workDir>/<repo>/` subdirectories**,
   leaving the workspace root for `AGENTS.md`, the `.lastlight-skills/` bundle,
   the `.lastlight-run` marker, and `.lastlight/issue-N/` scratch
   (`src/sandbox/index.ts:267`). Sibling repos at `<workDir>/<repoA>/` and
   `<workDir>/<repoB>/` are a natural extension of the current layout — no new
   directory model needed. The agent's cwd stays the **primary** repo; siblings
   are reachable at `../<repo>`.

So the work is mostly **widening a scalar to a list** along one call chain, plus
prompt/branch/PR plumbing for the secondary repos.

## Design overview

Introduce an optional **`secondaryRepos`** list that rides alongside the
existing primary `owner`/`repo` everywhere the primary travels. Keep the
primary scalar fields intact (minimal blast radius; all single-repo runs keep
working byte-for-byte). The list carries, per repo: `owner`, `repo`, and an
optional `branch`/`prePopulateBranch`.

```
trigger (--with)                EventEnvelope/API body
   │                                   │
   ▼                                   ▼
SimpleWorkflowRequest.extra.secondaryRepos   (passthrough, no type churn at the edge)
   │
   ▼
TemplateContext.secondaryRepos        (typed, for prompts)
   │
   ▼
GitSandboxAccess.secondaryRepos       (typed, for token + clone)
   │              │
   │              ├── token: repositories = [primary, ...secondary]  (one scoped token)
   │              │
   ▼              ▼
prepareRun.prePopulate = { primary, secondary[] }
   │
   ▼
prePopulateWorkspace: clone each repo into <workDir>/<repo>/   (loop)
```

## Touch points (by layer)

### 1. Trigger ingestion — accept the extra repos
- **`src/cli.ts`** — `cmdBuild` (`:805`) and `cmdSkill` (`:816`): parse a
  repeatable `--with <owner/repo>` flag (the flag parser at `:38-85` already
  treats unknown non-boolean flags as value flags; may need to accumulate
  repeats into an array). Add `secondaryRepos: string[]` to the `/api/build`
  body and into `context` for `/api/run`.
- **`src/index.ts`** — `/api/build` handler (`:719`) reads the new field and
  passes it into `dispatchWorkflow`'s context; `/api/run` (`:693`) needs nothing
  (anything extra already flows via `context`).
- **Comment trigger (optional, later)** — `src/engine/router.ts` could parse a
  `@last-light build --with owner/other` directive from a comment body. Out of
  scope for the first cut but the same `extra` passthrough applies.

### 2. Request → context threading (mostly free)
- **`src/index.ts`** `dispatchWorkflow` (`:234-255`): `secondaryRepos` is not in
  the destructured known-fields list, so it falls into `...rest` → `extra`
  automatically. No change needed unless we want it as a first-class field.
- **`src/workflows/simple.ts`** — `SimpleWorkflowRequest` (`:26`): read
  `request.extra.secondaryRepos` (or promote to a typed field). Parse each
  `"owner/repo"` string into `{ owner, repo }`. Set it on the
  `TemplateContext` built at `:363`.
- **`src/workflows/templates.ts`** — `TemplateContext` (`:11`): add
  `secondaryRepos?: { owner: string; repo: string; branch?: string }[]`.

### 3. Allowlist / validation (new)
- **`src/managed-repos.ts`** `isManagedRepo()`: the CLI/HTTP API path currently
  does **no** managed-repo check (it trusts the authenticated caller); only the
  webhook/router path enforces it (`src/engine/router.ts:45`). Decision point:
  for `write-to-all`, each secondary repo grants write — so validate each
  against `getManagedRepos()` in the `/api/build` handler (or in
  `dispatchWorkflow` right after `:250`) and reject unmanaged repos. This is a
  **security-relevant** addition, since a writable token will be minted for
  every listed repo.

### 4. Token minting — one token, N repos
- **`src/engine/profiles.ts`** `GitSandboxAccess` (`:220`): add
  `secondaryRepos?: { owner: string; repo: string; prePopulateBranch?: string }[]`.
- **`src/workflows/runner.ts`** `gitSandboxAccessForWorkflow` (`:100`): accept
  and forward the secondary list. The single `profile` (`repo-write` for
  build/pr-fix) applies to **all** repos in the token — consistent with the
  "write to all" decision. (If per-repo access ever differs, the token API
  can't express that; you'd mint multiple tokens — explicitly out of scope.)
- **`src/engine/agent-executor.ts`** `prepareRun` (`:261-275`): build
  `repositories = [access.repo, ...secondary.map(r => r.repo)]` and pass to
  `refreshGitAuth`. The minted token already works for all of them.

### 5. Workspace provisioning — clone each repo
- **`src/sandbox/index.ts`** `prePopulateWorkspace` (`:250`): today clones one
  repo. Refactor the per-repo clone body into a helper and **loop** over
  `[primary, ...secondary]`, each into `<workDir>/<repo>/` using the **same**
  minted token in the URL (`:260`). The `.lastlight-run` marker stays
  **workspace-level** (`:268`) — written once after all clones; the
  same-run-preserve / different-run-refresh logic (`:271-283`) should run
  **per repo** (check `<workDir>/<repoX>/.git`) so a reused workspace refreshes
  every sibling. `refreshExistingClone` (`:379`) is already per-repo-dir, so it
  just gets called once per repo.
- **`PrePopulate` type** (`:224`) and `prepareRun`'s inline prePopulate type
  (`src/engine/agent-executor.ts:224`): widen to carry the list, or pass an
  array of `PrePopulate`. Cleanest: `prePopulateWorkspace(workDir, primary, secondary[])`.
- **taskId / per-PR reuse** (`src/workflows/simple.ts:95`,
  `PER_TARGET_REUSE_WORKFLOWS`): unaffected — taskId stays keyed by the
  **primary** repo+number. Multiple sibling checkouts live under that one
  workspace dir.

### 6. Agent cwd & repo awareness
- **`src/engine/agent-executor.ts`** agentCwd (`:572` docker, `:613`
  gondolin/none): keep cwd = **primary** repo (`<workDir>/<primaryRepo>`). No
  change to the cwd computation; the secondary checkouts simply exist as
  siblings at `../<repo>`.
- **Prompts** (`workflows/prompts/architect.md`, `executor.md`, `reviewer.md`):
  today they say "You are already inside the {{repo}} repo … your cwd is the
  repo root" (`architect.md:3`). Add a templated block listing secondary repos
  and their sibling paths so the agent knows they exist and can `cd ../<repo>`
  to work in them, branch, and open PRs there. Drive it from
  `{{#if secondaryRepos}} … {{/each}}`.

### 7. Write-to-all: branches, commits, PRs in secondary repos
This is the genuinely new behavioral surface (vs. just "checkout for context"):
- The minted token already grants write to every repo, and the MCP GitHub
  tools (`mcp-github-app/`) take explicit `owner`/`repo` params — so they can
  already open PRs/comment on any repo the token covers. No MCP change needed.
- **Build-asset / handoff docs** (`src/state/build-assets.ts`): keyed by
  `<owner>/<repo>/<issueKey>` (the **primary**). For v1, keep a single
  primary-keyed asset dir holding the plan/summary that may reference changes
  across repos. Per-repo asset partitioning is a possible later refinement.
- **Branch naming**: each repo gets its own `lastlight/<n>-<slug>` branch
  (the pre-clone's missing-branch fallback at `src/sandbox/index.ts:304`
  already creates the build branch locally per repo). PR creation is the
  agent's job via MCP, one PR per repo it changed.
- **Cross-repo PR linking** (nice-to-have): instruct the agent (in prompts) to
  cross-reference the sibling PRs so reviewers see the set.

### 8. Things that intentionally stay single-repo
- `EventEnvelope.repo` (`src/connectors/types.ts:16`) — the *originating* event
  is still one repo; secondary repos are a run-level attachment, not an event
  property. No change.
- `AGENTS.md` / agent-context — global per instance, repo-agnostic. No change.
- `.lastlight-skills/` bundle — phase-scoped at the workspace root, repo-
  agnostic. No change.
- Trigger id / `workflow_runs` row — anchored to the primary
  (`src/workflows/runner.ts:157`). No change.

## Risks & open questions
- **Security**: "write to all" means a single run mints a write token covering
  several repos. The managed-repo allowlist check (§3) becomes load-bearing —
  without it, a CLI caller could attach an arbitrary repo and get write. Must
  land with the feature, not after.
- **Egress**: clones go to `github.com`, already in the strict allowlist — no
  firewall change. Secondary repos pulling private deps from other hosts would
  need `unrestricted_egress` as today; unchanged.
- **Partial-clone failure**: `prePopulateWorkspace` is best-effort per repo
  (`:338` falls through to an empty dir on failure). With multiple repos, decide
  whether a failed secondary clone should fail the run or proceed degraded.
  Recommend: fail fast for build (write) workflows, warn-and-continue for
  read-only ones.
- **Per-repo permission asymmetry**: not expressible with one token. If a future
  case needs repo A writable + repo B read-only, that requires multiple tokens
  + multiple git remotes with different creds — explicitly out of scope here.
- **Workspace size / reuse**: N checkouts per workspace multiplies disk and the
  `node_modules`-warm reuse benefit is per-repo-dir (already the case). Fine.

## Suggested phasing (when built)
1. Types + threading (`GitSandboxAccess`, `TemplateContext`,
   `SimpleWorkflowRequest`) — no behavior yet.
2. Token minting widened to the list (`prepareRun`).
3. `prePopulateWorkspace` loop + per-repo refresh.
4. CLI `--with` + `/api/build` body + **managed-repo validation**.
5. Prompt templates surface the sibling repos.
6. (Optional) comment-trigger `--with`, per-repo build-assets, cross-PR linking.

## Verification (for the eventual implementation)
- **Unit**: extend `prePopulateWorkspace` tests (the `__prePopulateWorkspaceForTest`
  export, `src/sandbox/index.ts:248`) to assert two sibling clones + a single
  workspace-level marker. Test `gitSandboxAccessForWorkflow` produces the
  combined `repositories` list. Test `--with` parsing in `src/cli.ts` and the
  allowlist rejection path in the `/api/build` handler.
- **Token**: assert `refreshGitAuth` is called with
  `repositories = [primary, ...secondary]` (mock the GitHub token endpoint).
- **Integration** (opt-in, `RUN_SANDBOX_IT=1`): run a no-AI `type: bash`
  workflow phase whose script asserts both `<workDir>/<repoA>` and
  `<workDir>/<repoB>` exist and are git repos, and that cwd is the primary.
- **End-to-end (manual)**: `lastlight build owner/repo#N --with owner/other`
  against two test repos; confirm in the dashboard session that the agent saw
  both checkouts, and that a writable token covered both (a commit/PR lands in
  each repo it touched).
