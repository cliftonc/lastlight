# Architect plan for #61 — filesystem overlay and first-class configuration

## Problem Statement

Last Light currently resolves deploy-specific behavior from hard-coded TypeScript defaults and single in-repo asset roots, so operators must fork or rebuild to change workflows, skills, prompts, agent context, routing, or managed repos. `loadConfig()` claims env vars override an optional config file, but it only reads `.env` plus environment variables and embeds defaults such as `workflowDir`, model, sandbox, approval gates, bootstrap label, and review checks in code (`src/config.ts:143-197`). The workflow loader has one mutable `workflowDir` and one fixed skill root list, so `getWorkflow()`, raw YAML, prompt, and skill reads cannot layer an overlay over built-in assets (`src/workflows/loader.ts:12-21`, `src/workflows/loader.ts:105-130`, `src/workflows/loader.ts:154-216`). Routing and managed repos are also hard-coded (`src/engine/router.ts:35-74`, `src/engine/router.ts:126-219`, `src/engine/router.ts:333-426`, `src/managed-repos.ts:1-17`), while agent context is duplicated across TypeScript and the Docker entrypoint (`src/engine/profiles.ts:3-10`, `src/engine/profiles.ts:159-177`, `src/engine/chat.ts:1-10`, `deploy/sandbox-entrypoint.sh:41-44`).

## Summary of what needs to change

- Add a startup-only overlay model rooted at `LASTLIGHT_OVERLAY_DIR` with layer-aware resolution for `workflows/`, `workflows/prompts/`, `skills/`, and `agent-context/`.
- Introduce `config/default.yaml` as the canonical non-secret default config, merge optional overlay `config.yaml`, then apply legacy env overrides for compatibility.
- Move non-secret deploy behavior (managed repos, routes, models, variants, sandbox settings, approvals, cron/review/bootstrap/explore settings, disables) into a validated effective config.
- Replace hard-coded workflow route targets and managed repo lists with config-backed helpers while preserving current authorization, classification, screening, approval, and reply-gate logic.
- Consolidate agent context generation so chat, in-process/gondolin runs, and Docker runs all receive the same resolved `AGENTS.md` without rebuilding the sandbox image.
- Add a read-only dashboard config view with Default / Overlay / Merged tabs and redacted/omitted secrets.

## Files to modify

### Configuration

- `config/default.yaml` (new): Add human-readable non-secret defaults in the same schema accepted by overlay `config.yaml`.
- `src/config.ts:74-137`: Extend `LastLightConfig` with `overlayDir`, `managedRepos`, `routes`, `disabled`, and config-inspection metadata (`defaultConfig`, `overlayConfig`, `effectivePublicConfig`, or equivalent). Keep secret fields env-only.
- `src/config.ts:143-197`: Replace direct env/default construction with `loadDotEnv()`, parse `config/default.yaml`, optional `$LASTLIGHT_OVERLAY_DIR/config.yaml`, merge, validate, then apply env overrides. Fail on invalid/missing default config and missing/unreadable overlay dir.
- `src/config.ts:202-335`: Rework model, variant, sandbox, approval, and boolean parsing so env overrides patch file config rather than creating independent TypeScript defaults; invalid file config should throw while invalid legacy env JSON can preserve current warn-and-ignore behavior if desired for compatibility.
- `src/config.test.ts:1-204`: Add tests for default YAML parsing, overlay merge rules, env override precedence, missing/unreadable overlay dir, invalid config errors, and public redaction.
- `package.json:10-18`: Add `config` to npm package `files`.
- `.env.example`, `README.md`, and docs: Document `LASTLIGHT_OVERLAY_DIR`, overlay layout, schema, env override precedence, restart requirement, and secrets policy.

### Asset overlay resolver

- `src/workflows/loader.ts:12-21`: Replace `workflowDir`/`setWorkflowDir()` with an initialized layer configuration, e.g. `configureWorkflowAssets({ builtInRoot, overlayRoot, disabled })`; keep `setWorkflowDir()` as a test/legacy wrapper if needed.
- `src/workflows/loader.ts:55-101`: Change lazy single-directory scan into ordered layer discovery. Detect duplicate workflow/cron names within a layer as fatal, allow overlay duplicate names to replace built-in names, and preserve origin metadata.
- `src/workflows/loader.ts:105-130`: Ensure `getWorkflow(name)` reads the winning logical workflow by `name`, not only `{name}.yaml`, and throws if disabled or absent.
- `src/workflows/loader.ts:134-152`: Apply the same layer/disables semantics to cron workflow definitions; decide whether disabled cron targets are filtered by `disabled.workflows` or a separate `disabled.crons` field during implementation.
- `src/workflows/loader.ts:154-159`: Make raw YAML return the winning workflow file by logical name and include origin metadata through a companion API if useful for dashboard/debug.
- `src/workflows/loader.ts:166-187`: Resolve prompts by checking overlay `workflows/<relativePath>` first, then built-in; preserve absolute/traversal rejection per root.
- `src/workflows/loader.ts:189-216`: Resolve skills by checking overlay `skills/<name>/SKILL.md`, then built-in `skills/`, then built-in `.claude/skills/`; keep flat skill-name validation.
- `src/workflows/loader.test.ts:1-120` and remaining loader tests: Cover overlay add/replace, prompt fallback/override, skill fallback/override, disables, traversal rejection, duplicate detection, and cache reset.

### Agent context and sandbox

- `src/engine/profiles.ts:3-10` and `src/engine/profiles.ts:159-177`: Move or delegate `loadAgentContext()` to the overlay resolver. Implement filename-based overlay replacement, sorted concatenation, `disabled.agentContext`, and allow `security.md` override/disable.
- `src/engine/chat.ts:1-10`: Remove duplicate `AGENT_CONTEXT_DIR`; import the shared resolved context function only if chat still needs a local helper.
- `src/index.ts:65-107`: Initialize config and asset resolver before creating `ChatRunner`; use resolved agent context for `systemPrompt: resolvedAgentContext + CHAT_SYSTEM_SUFFIX`.
- `src/engine/agent-executor.ts:154-161`: Use resolved agent context when writing `AGENTS.md` for in-process/gondolin/none runs.
- `src/engine/agent-executor.ts:333-383`: Ensure Docker workspaces get the same resolved `AGENTS.md` before `runAgent()` starts. This likely requires writing `AGENTS.md` after `createTaskSandbox()` creates/pre-populates the workspace and before the exec call.
- `src/sandbox/docker.ts:158`: Update assumptions/comments and, if necessary, expose a safe host-workspace path or helper so the executor can write `AGENTS.md` for Docker.
- `deploy/sandbox-entrypoint.sh:41-44`: Stop overwriting harness-written `AGENTS.md`; either remove the baked-context concatenation or guard it with `[ -f "$WORKSPACE/AGENTS.md" ] || ...`.
- `sandbox.Dockerfile:92-93`: Remove or demote baked `agent-context/` dependency; runtime correctness must not depend on this `COPY`.

### Routing and managed repos

- `src/managed-repos.ts:1-17`: Replace static `MANAGED_REPOS` with config-backed accessors such as `getManagedRepos()` / `isManagedRepo()`; keep compatibility exports only if they can safely reflect initialized config.
- `src/connectors/github-webhook.ts:124-132`: Continue filtering unmanaged repos, but call config-backed managed repo service.
- `src/engine/router.ts:4-20`: Inject or import a route/config service for route targets and managed repo error messages.
- `src/engine/router.ts:35-74`: Replace GitHub issue/PR opened/reopened/synchronize hard-coded `issue-triage` and `pr-review` targets with configured `routes.github.*` values.
- `src/engine/router.ts:126-219`: Replace approval/security/comment intent targets (`approval-response`, `security-review`, `pr-fix`, `pr-comment`, `github-orchestrator`, `explore`, `issue-comment`, `security-feedback`) with route config while preserving the current checks and context construction.
- `src/engine/router.ts:333-426`: Replace Slack intent targets (`github-orchestrator`, `issue-triage`, `pr-review`, `security-review`, `explore`, `chat`, status/reset/approval) with configured `routes.slack.*` values where applicable.
- `src/workflows/triggers.ts:1-29`: Replace the mirrored `STATIC_TRIGGERS` table with metadata derived from the resolved route config so dashboard trigger badges match dispatch behavior.
- `src/cli.ts:145-206`: Consider whether CLI command-to-workflow mappings should read configured routes or continue to call explicit workflow names. If kept out of scope, document that CLI mappings are legacy/manual dispatch.
- `src/cron/jobs.ts:1-40`: Use configured `managedRepos` for cron contexts.
- `src/admin/routes.ts:26` and `src/admin/routes.ts:861-966`: Use configured `managedRepos` in admin cron/manual run contexts.

### Startup validation

- `src/index.ts:25-59`: Extend `validateConfig()` or add `validateStartup()` to validate config files, overlay assets, duplicate names, configured route targets, disabled asset references, required built-in assets, and prompt/skill/context path safety before connectors, cron, chat, or admin start.
- `src/index.ts:65-83`: Initialize asset layers immediately after `loadConfig()` and before `ChatRunner`, DB side effects beyond opening the DB, admin mount, cron registration, or connector startup.
- `src/workflows/loader.ts`: Add `validateAssets()` or make initialization eagerly discover/validate all winning workflow and cron YAMLs. Current `populateCache()` logs and skips invalid files (`src/workflows/loader.ts:69-101`), which must become fail-fast for startup validation.

### Dashboard/API

- `src/admin/routes.ts:225-240`: Extend `AdminConfig` or route closure with effective public config data.
- `src/admin/routes.ts` near existing workflow routes: Add `GET /config` or `GET /config/effective` returning parsed default config, parsed overlay config or `null`, merged effective non-secret config, and optional asset origin/disabled metadata.
- `src/admin/routes.ts:681-807`: Ensure workflow list/full/raw YAML/prompt/skill endpoints use overlay-aware loader metadata/content.
- `dashboard/src/api.ts:1-420`: Add config response types and `api.config()` helper.
- `dashboard/src/App.tsx:25-36` and `dashboard/src/App.tsx:245-339`: Add `config` to tab type/list/nav/rendering.
- `dashboard/src/components/ConfigPage.tsx` (new): Render read-only Default / Overlay / Merged tabs, likely pretty-printed YAML/JSON, with secrets omitted/redacted.

## Implementation approach

1. **Define the config schema first.** Add `config/default.yaml` with current behavior: current managed repos, model default, empty variants, sandbox defaults, approval gates, bootstrap label, explore default, review settings, and current route mappings. Use `zod` or existing project dependencies to validate YAML into a typed shape.
2. **Refactor `loadConfig()` into layered config loading.** Load `.env`, require `config/default.yaml`, optionally load `$LASTLIGHT_OVERLAY_DIR/config.yaml`, merge using the issue’s rules (`managedRepos` replace, `models`/`variants`/`routes` deep-merge, arrays replace), then apply env overrides. Keep secrets (`githubApp`, Slack tokens/OAuth secrets, admin secret/password, provider API keys) env-only and out of dashboard output.
3. **Create config-backed runtime services.** Provide initialized accessors for effective config, public redacted config, routes, and managed repos. Avoid import-time mutable constants where possible; make tests able to reset state.
4. **Build the asset resolver.** Replace single-root `workflowDir` logic with immutable ordered layers: built-in root plus optional overlay root. Discover workflows/crons eagerly at startup, validate all winning YAML, record origins, apply disables after discovery, and preserve existing public loader APIs where possible.
5. **Integrate resolver at startup.** In `src/index.ts`, load config, configure/validate asset layers, validate route targets against enabled workflows, then continue normal startup.
6. **Move dispatch to configured routes.** Replace hard-coded router workflow names with `routeTarget("github.issue_opened")` style lookups. Preserve all control flow, authorization checks, approval/reply short-circuits, classifier calls, and injection-screen annotations.
7. **Move managed repos to config.** Update `managed-repos.ts`, GitHub webhook filtering, Slack router checks, cron fanout, admin cron/manual contexts, and tests to use `managedRepos` from effective config.
8. **Consolidate agent context.** Implement `loadResolvedAgentContext()` in or near the asset resolver. Use it for chat system prompt and executor-written `AGENTS.md`.
9. **Fix Docker context handling.** Make the harness write resolved `AGENTS.md` into the Docker workspace and prevent `deploy/sandbox-entrypoint.sh` from overwriting it.
10. **Add dashboard config API/UI.** Return redacted default/overlay/merged config from admin routes; add dashboard API types and a `ConfigPage` component with three read-only tabs.
11. **Update packaging and documentation.** Include `config/` in package files and document overlay layout and operational behavior.
12. **Backfill tests and run verification.** Add config/loader/router/admin/dashboard tests, then run `npm test`, `npm run build`, and `npm run build:dashboard` or `cd dashboard && npx tsc -b` depending on scope.

## Risks and edge cases

- **Import-time configuration state:** Many modules import constants today. Moving to runtime config can create initialization-order bugs unless accessors are explicit and tests reset them.
- **Duplicate workflow names:** Existing code silently overwrites by `Map.set()` during scan (`src/workflows/loader.ts:92`); new behavior must distinguish valid cross-layer replacement from invalid same-layer duplicates.
- **Fail-fast vs compatibility:** Current loader logs invalid YAML and continues (`src/workflows/loader.ts:69-101`), and config parsing warns on invalid model/variant JSON (`src/config.ts:265-287`, `src/config.ts:307-331`). File config should fail fast, but legacy env behavior may need to remain tolerant.
- **Workflow raw lookup by filename:** `loadWorkflowYamlRaw()` currently assumes `{name}.yaml` (`src/workflows/loader.ts:154-159`); overlay workflows may have arbitrary filenames with logical `name`, so raw views must be origin-aware.
- **Route targets may point to disabled workflows:** Validate configured routes after applying `disabled.workflows`; absent disabled entries should be ignored, but active routes to missing/disabled workflows must fail startup.
- **Agent context security:** The maintainer explicitly allowed `security.md` override/disable. This is powerful and should be documented as trusted deployment configuration only.
- **Docker timing:** The entrypoint currently writes `AGENTS.md` on container start (`deploy/sandbox-entrypoint.sh:41-44`), while the executor calls `runAgent()` after `createTaskSandbox()` (`src/engine/agent-executor.ts:333-383`). Ensure the harness write happens after container workspace creation and before the agent starts, and that chown/permissions remain correct.
- **Dashboard secret exposure:** The config page must never show private key paths if considered sensitive, tokens, OAuth secrets, provider keys, admin secret/password, or any raw env dump.
- **CLI mappings:** CLI has its own hard-coded command map (`src/cli.ts:145-206`). Decide whether this issue updates CLI to query config/routes from the server or documents it as manual workflow dispatch.
- **Packaged path resolution:** `config/default.yaml` and built-in asset roots must resolve correctly both from source (`tsx`) and compiled/package installs.

## Test strategy

- **Config tests (`src/config.test.ts`):** default YAML parses; overlay absent works; overlay missing dir fails; invalid YAML/schema fails with clear errors; merge rules match spec; env overrides win; secrets are not present in public config output.
- **Loader tests (`src/workflows/loader.test.ts`):** overlay workflow add; overlay workflow replace by logical `name`; same-layer duplicate failure; prompt overlay/fallback/traversal rejection; skill overlay/fallback/invalid name; disabled workflows/prompts/skills/context; raw YAML returns winning content; cache/layer reset between tests.
- **Agent context tests:** built-in plus overlay filename replacement; overlay-only additions; sorted concatenation with `\n\n---\n\n`; `security.md` override and disable; absent disabled filenames ignored.
- **Router tests:** GitHub and Slack route keys select configured workflow names while existing maintainer checks, bot mention checks, approval/reply gates, classifier/screener behavior, and unmanaged repo replies still work.
- **Managed repo tests:** `isManagedRepo()` and all call sites honor config `managedRepos`; cron/admin contexts use configured repos.
- **Startup validation tests:** missing route target, disabled route target, invalid winning workflow YAML, and duplicate same-layer workflows fail before services start.
- **Admin/API tests (`src/admin/routes.test.ts`):** config endpoint returns default/overlay/merged; secrets are redacted/omitted; workflow/prompt/skill raw endpoints use overlay-winning content.
- **Dashboard type/UI checks:** Add API types and component tests if existing patterns permit; at minimum run dashboard typecheck/build.
- **Verification commands:** `npm test`, `npm run build`, `npm run build:dashboard` (or `cd dashboard && npx tsc -b`). Guardrails report already confirmed Vitest and TypeScript are available; linting is not configured.

## Estimated complexity

Complex. This is a cross-cutting architecture change touching startup configuration, asset loading, dispatch routing, managed repo authorization, sandbox setup, admin API, dashboard UI, packaging, documentation, and test fixtures.
