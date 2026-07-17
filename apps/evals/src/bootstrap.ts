/**
 * Core-asset bootstrap — the one thing an out-of-process eval harness MUST do
 * that the in-repo version never had to.
 *
 * Last Light's `getWorkflow` resolves built-in workflows/skills/agent-context
 * from `DEFAULT_ROOT = resolve(".")` (the process cwd). In-repo that happened to
 * be the core checkout, so it "just worked". As a separate package our cwd is
 * wherever the user invoked the CLI, so we MUST tell core where its assets live
 * by calling `configureWorkflowAssets({ builtInRoot })` BEFORE any
 * `getWorkflow`/`runWorkflow`. Forget this and workflows silently fail to
 * resolve. {@link bootstrapAssets} is therefore the first call in `run`.
 */
import { createRequire } from "node:module";
import { dirname } from "node:path";

import { configureWorkflowAssets } from "lastlight-core/evals";

/**
 * The `lastlight-core` PACKAGE ROOT — the dir holding `workflows/`, `skills/`,
 * `agent-context/`, `config/`, `dist/`.
 *
 * Default: resolve the `lastlight-core` package (a `workspace:*` dependency in
 * the monorepo; a normal npm dependency once published).
 *
 * Override: `LASTLIGHT_CORE_DIR` repoints the ASSET roots at a local core
 * checkout (the monorepo core package dir, `.../apps/server`), so you can eval
 * un-published workflow/prompt/skill edits — the bulk of what `lastlight server
 * update` ships — without bumping the dep. Caveat: the imported runner CODE
 * still comes from `node_modules/lastlight-core`; to also exercise
 * working-tree engine code, use the workspace symlink (or a `file:` dep).
 */
export function resolveCoreRoot(): string {
  const override = process.env.LASTLIGHT_CORE_DIR?.trim();
  if (override) return override;
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("lastlight-core/package.json"));
}

export interface BootstrapResult {
  builtInRoot: string;
  overlayDir?: string;
}

/**
 * Point core's asset layers at the resolved core root (+ optional overlay).
 * MUST run before the first workflow access. An overlay's workflows/skills/
 * agent-context shadow the built-ins by logical name — the same precedence the
 * production harness uses via `LASTLIGHT_OVERLAY_DIR`.
 */
export function bootstrapAssets(opts: { overlayDir?: string } = {}): BootstrapResult {
  const builtInRoot = resolveCoreRoot();
  configureWorkflowAssets({ builtInRoot, overlayRoot: opts.overlayDir });
  return { builtInRoot, overlayDir: opts.overlayDir };
}
