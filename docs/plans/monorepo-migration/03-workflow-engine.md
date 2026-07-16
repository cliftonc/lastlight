# Phase 3 — Extract `@lastlight/workflow-engine`

Risk: **medium**. Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc assumes
their locked decisions (turbo `^build` ordering, release freeze, Node16
resolution for published packages).

> **This is a bridge doc, not a restatement.** The extraction itself executes
> [`docs/workflow-engine-extraction-design.md`](../../workflow-engine-extraction-design.md)
> — its §6 sequence (Milestone A steps 1–8, Milestone B step 9), its port
> definitions (§2), its composition root (§3), its behavior-held-verbatim list
> (§4), and its regression fences (§7) apply **verbatim**. This doc adds only
> what the monorepo changes: where files land, the package lift mechanics, and
> how the fences wire into the workspace. When this doc and the extraction doc
> disagree on engine semantics, the extraction doc wins.

## Goal

Extract the workflow engine out of `apps/server/src/workflows/` into a
standalone, port-driven, publishable package `@lastlight/workflow-engine`
(`packages/workflow-engine`), in two milestones:

- **Milestone A** — the engine becomes an in-repo module at
  `apps/server/src/workflow-engine/{core,ports,test-support}` with the
  boundary proven by a dependency-cruiser gate and the new contract fence
  tests. Eight steps, each leaving the suite green.
- **Milestone B** — the proven module lifts to `packages/workflow-engine`;
  core depends on it `workspace:*`; the old `src/workflows/*` shim paths
  re-point at the package.

The package becomes **publish-ready but is not published here** — the first
npm publish is manual (locked decision 15) and typically happens at Phase 4's
F4 gate (the decision-5 carve-out for new scoped names), else in Phase 7's
runbook.

## Preconditions

- Phase 2 complete and its checkbox ticked: core lives at `apps/server/`
  (package still **named `lastlight`** — the `@lastlight/core` rename is
  Phase 4). All paths in the extraction doc are now relative to
  `apps/server/`: its anchor files are
  `apps/server/src/workflows/{runner,phase-executor,schema,simple,resume,loader,templates,dag,phase-ref,verdict,loop-eval,target-policy}.ts`,
  `apps/server/src/engine/github/profiles.ts`, `apps/server/src/state/db.ts`,
  `apps/server/src/evals-api.ts`, `apps/server/src/sandbox/sandbox.ts`
  (`FakeSandbox` prior art), `apps/server/tests/workflows/*`.
- Repo green from a clean checkout:
  `pnpm install --frozen-lockfile && pnpm turbo run typecheck test build`.
- Read `apps/server/src/workflows/CLAUDE.md` (runner internals) before step 1.

## Files created / modified

| File | Change |
|---|---|
| `apps/server/src/workflow-engine/core/*.ts` | **new** (Milestone A) — dag, phase-ref, verdict, loop-eval, templates, schema, types, scheduler, phase-executor |
| `apps/server/src/workflow-engine/ports/ports.ts` | **new** — AgentPort, WorkflowStateStore, AssetLoader, LivenessPort, PhaseReporter, PhaseResolver, PhaseTypeHandler, EngineDeps |
| `apps/server/src/workflow-engine/test-support/fakes.ts` | **new** — FakeAgentPort, InMemoryStateStore, RecordingReporter, StubAssetLoader |
| `apps/server/src/workflows/{dag,phase-ref,verdict,loop-eval,templates,schema}.ts` | become one-line re-export shims (step 1) |
| `apps/server/src/workflows/handlers/post-review.ts` | **new** (step 6) — app-registered `PhaseTypeHandler` |
| `apps/server/src/workflows/runner.ts` | reduced to the composition root (step 7); 9-arg `runWorkflow` signature byte-stable |
| `apps/server/tests/workflows/evals-contract.test.ts` | **new fence** — barrel surface pin |
| `apps/server/tests/workflows/state-store-contract.test.ts` | **new fence** — `StateDb satisfies WorkflowStateStore` |
| `apps/server/.dependency-cruiser.cjs` | **new** — boundary gate config |
| `apps/server/package.json` | devDep `dependency-cruiser`; script `lint:boundaries`; (Milestone B) dep `@lastlight/workflow-engine: workspace:*` |
| `packages/workflow-engine/{package.json,tsconfig.json,src/**}` | **new** (Milestone B) — the lifted module |
| `pnpm-workspace.yaml` | gains `"packages/*"` (if not already present from Phase 1) |
| `turbo.json` | no change expected — `build.dependsOn: ["^build"]` already orders engine before core |

`apps/server/src/evals-api.ts` is **not modified** in this phase (the shims
keep every re-export source path alive).

## Steps

### Milestone A — in-repo module (extraction doc §6 steps 1–8)

Execute the extraction doc's steps in order, inside `apps/server/`. One
commit per step; after every step:
`pnpm --filter lastlight test` green (the package is still named `lastlight`).

1. **Pure leaves move** — `dag`, `phase-ref`, `verdict`, `loop-eval`,
   `templates`, `schema` → `src/workflow-engine/core/`; one-line re-export
   shims stay at the old `src/workflows/*` paths. The shims are load-bearing:
   `src/evals-api.ts` re-exports `TemplateContext` from
   `./workflows/templates.js` and `src/workflows/loader.ts` imports
   `./schema.js` — both must keep resolving unchanged.
2. **Shared types re-home** — `ExecutorConfig`, `ExecutionResult`,
   `CommandSpec`, `GitSandboxAccess` → `core/types.ts`;
   `src/engine/github/profiles.ts` and `src/engine/agent-executor.ts`
   re-export them (kills the engine→app type dependency).
3. **Ports land** — `ports/ports.ts` with the §2 interfaces;
   `PhaseRunContext.db: StateDb` → `store: WorkflowStateStore` (structural —
   compiles unchanged); `PhaseReporter`/`PhaseResolver` re-home.
4. **`AgentPort` inversion** — phase execution takes the port;
   `defaultAgentPort` built in `runner.ts`; tests inject `FakeAgentPort`.
5. **`AssetLoader` + `LivenessPort` inversion** — drop the `loader`/`docker`
   `vi.mock`s.
6. **`post-review` lift** — to `src/workflows/handlers/post-review.ts` as an
   app-registered `PhaseTypeHandler`; engine dispatches unknown phase types
   via `deps.handlers`.
7. **Scheduler split** — `runWorkflowCore` → `core/scheduler.ts`; app
   `runWorkflow` becomes the §3 composition shim (9-arg signature
   **byte-stable**).
8. **Boundary enforcement** — the dependency-cruiser gate (below) goes green.

### Fence tests (land with steps 2–3, before the inversions)

9. `apps/server/tests/workflows/evals-contract.test.ts`: asserts
   `runWorkflow.length === 9` and `expectTypeOf` pins on `RunnerCallbacks`,
   `WorkflowResult`, `ExecutorConfig.githubApiBaseUrl` (the frozen
   `lastlight/evals` surface — extraction doc §7).
10. `apps/server/tests/workflows/state-store-contract.test.ts`: type-asserts
    `StateDb satisfies WorkflowStateStore` so a future `StateDb` change
    surfaces at compile time.

### Dependency-cruiser gate

11. `pnpm --filter lastlight add -D dependency-cruiser`. Config
    `apps/server/.dependency-cruiser.cjs` with one `forbidden` rule:
    from `^src/workflow-engine` to
    `^src/(engine|state|notify|admin|connectors|config|sandbox|cli)` **or**
    node_modules `better-sqlite3|octokit` — severity `error`. (The engine's
    only allowed externals are `zod` and node built-ins.)
12. Wire it as `apps/server/package.json` script
    `"lint:boundaries": "depcruise --config .dependency-cruiser.cjs src"`,
    and append it to the package's `typecheck` flow (or run it explicitly in
    verification). A root CI step is **Phase 7's** job — do not touch
    `.github/workflows/` here.

### Milestone B — lift to `packages/workflow-engine` (extraction doc step 9)

Only after step 8's gate is green.

13. `git mv apps/server/src/workflow-engine packages/workflow-engine/src`
    (own commit). Add:
    - `packages/workflow-engine/package.json`:
      `name: "@lastlight/workflow-engine"`, `version: "0.1.0"`,
      `type: "module"`, `main`/`types` → `dist/index.*`, `files: ["dist"]`,
      runtime deps: **`zod` only**. Exports — **one root barrel plus a
      test-support subpath** (locked here; do not add per-dir subpaths):
      ```json
      "exports": {
        ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
        "./test-support": { "types": "./dist/test-support/fakes.d.ts", "import": "./dist/test-support/fakes.js" },
        "./package.json": "./package.json"
      }
      ```
      `src/index.ts` re-exports everything from `core/` + `ports/`;
      `./test-support` stays a separate subpath so the fakes never enter a
      consumer's production import graph.
    - `packages/workflow-engine/tsconfig.json`: `extends:
      "../../tsconfig.base.json"`, `module`/`moduleResolution: Node16`,
      `outDir: dist`, `rootDir: src`.
14. `apps/server/package.json` adds
    `"@lastlight/workflow-engine": "workspace:*"`. Re-point the old
    `src/workflows/*` shims and every direct `#src/workflow-engine/...`
    import at the package (`@lastlight/workflow-engine` /
    `@lastlight/workflow-engine/test-support`). Ensure `pnpm-workspace.yaml`
    contains `"packages/*"`.
15. Keep (don't delete) `apps/server/.dependency-cruiser.cjs` — retarget the
    rule so `src/**` may import the package but the package name never
    appears importing app code (belt); add a second config or rule in
    `packages/workflow-engine` forbidding any import outside
    `src/**` + `zod` + node built-ins (braces).
16. Build order is automatic: turbo `build.dependsOn: ["^build"]` builds the
    engine's `dist/` (+ `.d.ts`) before core compiles against it. Verify with
    `pnpm turbo run build --dry-run=text` (engine appears before the server
    package).

## Verification

The extraction doc's §7 fences, verbatim, plus the workspace gates:

```bash
# after EVERY Milestone A step
pnpm --filter lastlight exec vitest run src/workflows/ tests/workflows/
# golden-build phase sequence pinned (must be untouched)
pnpm --filter lastlight exec vitest run tests/workflows/golden-build.test.ts
# boundary gate (step 8 onward)
pnpm --filter lastlight run lint:boundaries
# full workspace
pnpm turbo run typecheck test build
```

**Evals smoke (extraction doc fence 5)** — the evals repo is *not yet
imported* (that's Phase 6), so smoke the standalone checkout against this
branch:

```bash
cd ~/work/lastlight-evals
npm link ../lastlight/apps/server        # link the WORKING-TREE core package
LASTLIGHT_CORE_DIR=~/work/lastlight/apps/server npx tsx src/run.ts run <case>
```

Caveat (from `lastlight-evals/src/bootstrap.ts` comments): `LASTLIGHT_CORE_DIR`
repoints only the **asset** roots; the runner **code** still resolves from
`node_modules/lastlight` — the `npm link` is what exercises the extracted
engine. Both are required. One case end-to-end against mocked GitHub must pass.

## Rollback

Milestone A is eight individually revertible commits — `git revert` back to
the last green step. Milestone B is one `git mv` commit + one wiring commit;
reverting both restores the in-repo module. Nothing is published in this phase
(release freeze), so rollback has no external blast radius.

## Out of scope

- Publishing the package (manual — earliest at Phase 4's F4 gate,
  decision 15).
- The `@lastlight/shared` package and the loader move (Phase 4) — `loader.ts`
  **stays app-side** in this phase, per the extraction doc's "stays in the
  app" list.
- Renaming the server package (Phase 4).
- Parallelizing the DAG walk, `currentPhase` resume indexes, or any engine
  behavior change (extraction doc §4 — held verbatim).
- CI workflow edits (Phase 7).

## Deviations

Executed 2026-07-16. **Step 1 (pure-leaves move) was landed by a prior agent**
as commit `20fa7b6` (dag/phase-ref/verdict/loop-eval/templates/schema moved to
the in-repo `core/` with one-line re-export shims at the old `src/workflows/*`
paths); this pass continued from step 2.

- **Two extra injected ports beyond the design's four.** The design lists
  AgentPort / WorkflowStateStore / AssetLoader / LivenessPort +
  PhaseTypeHandler. Two more couplings had to be inverted for the engine to be
  genuinely self-contained once it becomes a zod-only package (Milestone B):
  - **`ObservabilityPort`** — the dedup ledger is instrumented with
    `withSpan` / `recordExecutionMetrics` / `recordError` (from `src/telemetry`,
    which pulls in `@opentelemetry/*`). `telemetry` isn't in the design's
    forbidden-dir list, but a package can't import `../telemetry`, so it's a
    seam (default adapter wraps the real telemetry; a no-op impl ships in
    `test-support`). The engine types the span opaquely (`EngineSpan`) so it
    never pulls in `@opentelemetry`.
  - **`VerdictArtifactReader`** — the reviewer loop's stdout-missing fallback
    read `reviewer-verdict.md` from the build-asset store / host checkout
    (`BuildAssetStore` + fs). Inverted to an optional injected reader
    (`src/workflows/handlers/verdict-reader.ts`); absent ⇒ the fallback no-ops
    (the safe "no recoverable verdict" path).
  Also **`botName`** (was `getBotName()` from config) is threaded as a field on
  `PhaseRunContext` rather than a port.
- **`HostCapabilities` seam for the scheduler.** The `requires_sandbox` /
  `sandbox_image: qa` gates used `qaImageAvailable()` + `SANDBOX_IMAGE_QA` from
  `src/sandbox/images`. Injected as `deps.capabilities` (docker-free) so
  `core/scheduler.ts` never imports `../sandbox`.
- **`runWorkflowCore` signature differs from design §3's sketch.** It takes
  `(runScope: PhaseRunContext, deps: SchedulerDeps, outputs?)` — the app
  composition root builds `runScope` + the default ports/adapters and passes a
  **shared** `outputs` map (so the app's notify/render closures and the engine
  loop see the same accumulating `phaseOutputs`). The DAG-walk + wrap-up moved
  wholesale into the core scheduler; the app `runWorkflow`'s **9-arg signature
  is byte-stable** (the frozen `lastlight/evals` surface — `evals-api.ts`
  untouched). The terminal-ping / footer gating uses a `reporterActive` flag
  since the core sees only the `PhaseReporter` port (extended with `footer` +
  `noteTerminal`), not the app's `ProgressReporter`.
- **dep-cruiser strengthened + version.** `dependency-cruiser` resolved to
  `^18.1.0` (not `^17`). The gate uses `tsPreCompilationDeps: true` (catches
  type-only app imports too — required since the Milestone-B package can't even
  type-import app code) and, beyond the design's single "no app-src / no
  better-sqlite3|octokit" rule, adds a **zod-only externals** rule (the engine's
  only allowed external is zod + node built-ins). Two configs exist: the
  package-local `packages/workflow-engine/.dependency-cruiser.cjs`
  (self-contained + zod-only, with `@types/node` allowed for node-builtin types)
  and the app-side belt `apps/server/.dependency-cruiser.cjs` (barrel-only —
  forbids deep `dist/core|ports` imports). Both wired into each package's
  `typecheck` via a `lint:boundaries` script.
- **`@types/node` is a devDep of the engine package** and `crypto` →
  `node:crypto`, so the zod-only package still resolves the one node built-in it
  uses (`randomUUID`). The dep-cruiser zod-only rule explicitly allows
  `@types/node`.
- **Test migration, not vi.mock deletion.** `runner.test.ts` drives
  `runWorkflow` (composition root) so its existing `vi.mock`s of
  agent-executor/loader/docker still intercept via the default adapters —
  untouched. `phase-executor.test.ts` injects test ports that *delegate to those
  same mocks* (minimal churn, existing assertions kept); `post-review.test.ts`
  drives the lifted `GitHubPostReviewHandler` directly. `test-support/fakes.ts`
  ships the design's fakes for external consumers but the in-repo tests keep
  their mock style.
- **Step-1 shims now re-export the package barrel.** The `src/workflows/{dag,
  schema,templates,verdict,phase-ref,loop-eval,phase-executor}.ts` shims became
  `export * from "@lastlight/workflow-engine"` (the package exposes only a root
  barrel + `/test-support`, no deep subpaths). They stay until Phase 4's loader
  move / rename cleans them up.
- **Live evals smoke (extraction-design fence 5) not run.** It requires a
  provider API key (to run a real workflow against mocked GitHub) and `npm link`
  of the working-tree core — evals isn't imported until Phase 6. The automated
  proxy — `tests/workflows/evals-contract.test.ts` (`runWorkflow.length===9` +
  RunnerCallbacks/WorkflowResult/`ExecutorConfig.githubApiBaseUrl` pins) — plus
  the server's own `runWorkflow`-driven suite (`runner.test.ts`,
  `simple.test.ts` drive the same surface with mocked agents) pass, and
  `evals-api.ts` is unchanged.

Verification (all green): `pnpm install --frozen-lockfile` consistent;
`pnpm turbo run typecheck test build` → 7/7 tasks, 1096 tests pass (2 files, 7
tests skipped = docker/smol integration); both `lint:boundaries` gates clean
(engine: 14 modules / 0 violations; app: 153 / 0); `golden-build.test.ts`
untouched + passing; turbo `^build` orders `@lastlight/workflow-engine#build`
before `lastlight#build`; publishable tarball verified via `npm pack --dry-run`
(dist + test-support subpath), **not published** (release freeze). Pre-existing
`typecheck:test` failure in `tests/notify/transports.test.ts` is unrelated and
untouched (CI never runs it).
