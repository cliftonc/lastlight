/**
 * Filesystem anchors for the eval package.
 *
 * Built-in assets (the shipped sample `datasets/` + `models.json`) live at the
 * PACKAGE ROOT — one level above this file's dir, which is `src/` under tsx in
 * dev and `dist/` when built+installed. Resolving relative to `import.meta.url`
 * (not `process.cwd()`) keeps them findable no matter where the CLI is invoked
 * from — including out of `node_modules/lastlight-evals/`.
 *
 * Run OUTPUT, by contrast, is written under the caller's cwd (an installed
 * package dir is read-only), overridable via `LASTLIGHT_EVALS_OUT`.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** Package root: the dir holding `datasets/`, `models.json`, `package.json`. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Shipped sample datasets root (`<pkg>/datasets`). */
export function builtinDatasetsRoot(): string {
  return resolve(packageRoot(), "datasets");
}

/** Shipped default model registry (`<pkg>/models.json`). */
export function builtinModelsPath(): string {
  return resolve(packageRoot(), "models.json");
}

/**
 * Built dashboard SPA assets (`<pkg>/dashboard/dist`) served by `serve`. Shipped
 * prebuilt in the npm package so an installed CLI needs no Vite at runtime; in
 * this repo it's produced by `npm run build` (which also builds the harness).
 * Overridable via `LASTLIGHT_EVALS_DASHBOARD` for development.
 */
export function dashboardDistRoot(): string {
  return process.env.LASTLIGHT_EVALS_DASHBOARD
    ? resolve(process.env.LASTLIGHT_EVALS_DASHBOARD)
    : resolve(packageRoot(), "dashboard", "dist");
}

/** Where scorecards/artifacts are written (cwd-relative, NOT the package dir). */
export function resultsRoot(): string {
  return process.env.LASTLIGHT_EVALS_OUT
    ? resolve(process.env.LASTLIGHT_EVALS_OUT)
    : resolve(process.cwd(), "eval-results");
}

/**
 * The tier-combo directory — `<resultsRoot>/<tiersKey>`. It holds the
 * overview/history `index.html` plus one timestamped subdir per run, so runs
 * accumulate instead of overwriting each other.
 */
export function tierResultsDir(tiersKey: string): string {
  return join(resultsRoot(), tiersKey);
}

/** Short git SHA of HEAD, or `undefined` outside a repo / on any failure. */
export function gitShortSha(): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const sha = r.status === 0 ? r.stdout.trim() : "";
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sortable, filesystem-safe run id: `YYYY-MM-DD_HHMMSS` (UTC, matching the
 * `toISOString()` timestamps used elsewhere) optionally suffixed with the short
 * git SHA of the code under test (e.g. `2026-06-28_143052-a0229c5`). If
 * `parentDir` already holds that id, a numeric `-2`/`-3` suffix is appended so
 * two runs in the same second never collide.
 */
export function makeRunId(date: Date, gitSha?: string, parentDir?: string): string {
  // 2026-06-28T14:30:52.123Z → 2026-06-28_143052
  const stamp = date.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "").replace("T", "_");
  const base = gitSha ? `${stamp}-${gitSha}` : stamp;
  if (!parentDir) return base;
  let id = base;
  for (let n = 2; existsSync(join(parentDir, id)); n++) id = `${base}-${n}`;
  return id;
}
