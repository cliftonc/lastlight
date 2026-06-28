/**
 * Host-local `lastlight fork <target>` — copy a built-in workflow (plus every
 * prompt and skill its phases reference) or the agent-context files
 * (`soul.md` and friends) into the deployment overlay so they can be edited
 * per-deployment.
 *
 * Like `lastlight server …`, this operates on files in a working directory —
 * not over HTTP. The overlay wins by logical name at startup (see
 * `src/workflows/loader.ts`), so a forked copy under `instance/` transparently
 * shadows the built-in once the agent restarts.
 *
 *   lastlight fork build              # build.yaml + its prompts + skills → instance/
 *   lastlight fork agent-context      # soul.md / rules.md / security.md → instance/
 *   lastlight fork agent-context soul.md   # just one context file (explicit)
 *   lastlight fork                    # list forkable targets (and what's already forked)
 *
 * Targets are explicit: a bare name is a workflow, agent-context is forked only
 * via the literal `agent-context` target — never guessed from a filename.
 *
 * Importing `./workflows/loader.js` + `./workflows/schema.js` is safe here:
 * both are pure (fs + yaml); their only `../config.js` import is type-only and
 * erased at runtime, so no harness/DB is pulled into the CLI.
 */
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  configureWorkflowAssets,
  getWorkflow,
  getWorkflowOrigin,
  listAgentWorkflows,
  resolveSkillPaths,
} from "../workflows/loader.js";
import { phaseSkillNames } from "../workflows/schema.js";
import { resolveServerHome } from "./cli-config.js";
import { enumerateOverlayAssets } from "../config/overlay-assets.js";

export interface ForkOpts {
  /** `--home <dir>` override for the working directory (the core checkout). */
  home?: string;
  /** `--force` — overwrite assets that already exist in the overlay. */
  force?: boolean;
}

// ── path resolution ────────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A directory that ships the built-in assets we fork *from*. */
function hasBuiltins(dir: string): boolean {
  return isDir(path.join(dir, "workflows")) && isDir(path.join(dir, "skills"));
}

/** A directory that looks like a deployment overlay (config + secrets), not a
 *  core checkout (which keeps config under config/default.yaml, no secrets/). */
function looksLikeOverlay(dir: string): boolean {
  return (
    !hasBuiltins(dir) &&
    (fs.existsSync(path.join(dir, "config.yaml")) || isDir(path.join(dir, "secrets")))
  );
}

export interface ForkTarget {
  /** Source of the built-in assets (the lastlight checkout root). */
  coreRoot: string;
  /** Overlay destination root (the instance/ folder). */
  instanceDir: string;
}

/**
 * Resolve where to read built-ins from and where to write the fork.
 * - An explicit `--home` wins outright → `<home>` + `<home>/instance`.
 * - Standing inside an overlay → write here, read built-ins from the parent
 *   checkout (or the resolved server home).
 * - Standing in a core checkout → write to `<checkout>/instance`.
 * - Otherwise → fall back to `LASTLIGHT_HOME` / the saved / default server home.
 */
export function resolveForkTarget(opts: ForkOpts): ForkTarget {
  // An explicit flag is unambiguous intent — it overrides cwd auto-detection.
  if (opts.home) {
    const home = path.resolve(opts.home);
    return { coreRoot: home, instanceDir: path.join(home, "instance") };
  }

  const cwd = process.cwd();

  if (looksLikeOverlay(cwd)) {
    const parent = path.dirname(cwd);
    const coreRoot = hasBuiltins(parent) ? parent : resolveServerHome(opts.home);
    return { coreRoot, instanceDir: cwd };
  }
  if (hasBuiltins(cwd)) {
    return { coreRoot: cwd, instanceDir: path.join(cwd, "instance") };
  }
  const home = resolveServerHome(opts.home);
  return { coreRoot: home, instanceDir: path.join(home, "instance") };
}

// ── copy helpers ───────────────────────────────────────────────────────────

type Action = "copied" | "skipped" | "overwritten";
interface CopyResult {
  /** Overlay-relative path of the asset. */
  rel: string;
  action: Action;
}

/** Copy a single file, honouring skip-existing / `--force`. */
function copyFile(src: string, destAbs: string, rel: string, force: boolean): CopyResult {
  const exists = fs.existsSync(destAbs);
  if (exists && !force) return { rel, action: "skipped" };
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(src, destAbs);
  return { rel, action: exists ? "overwritten" : "copied" };
}

/** Copy a directory tree, honouring skip-existing / `--force`. */
function copyDir(src: string, destAbs: string, rel: string, force: boolean): CopyResult {
  const exists = fs.existsSync(destAbs);
  if (exists && !force) return { rel, action: "skipped" };
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.cpSync(src, destAbs, { recursive: true, force: true });
  return { rel, action: exists ? "overwritten" : "copied" };
}

// ── fork actions ───────────────────────────────────────────────────────────

/** Copy a workflow YAML + every prompt and skill its phases reference. */
function forkWorkflow(t: ForkTarget, name: string, force: boolean): CopyResult[] {
  const def = getWorkflow(name); // throws if unknown — caller lists + exits
  const origin = getWorkflowOrigin(name);
  const results: CopyResult[] = [];

  // The workflow YAML itself (origin handles .yaml vs .yml).
  if (origin) {
    const file = path.basename(origin.filePath);
    results.push(copyFile(origin.filePath, path.join(t.instanceDir, "workflows", file), `workflows/${file}`, force));
  }

  // Prompt templates referenced by phases (skip empties + templated refs).
  const prompts = new Set<string>();
  const skillNames = new Set<string>();
  for (const phase of def.phases) {
    for (const ref of [phase.prompt, phase.loop?.on_request_changes.fix_prompt, phase.loop?.on_request_changes.re_review_prompt]) {
      if (typeof ref === "string" && ref.length > 0 && !ref.includes("{{")) prompts.add(ref);
    }
    for (const s of phaseSkillNames(phase)) {
      if (!s.includes("{{")) skillNames.add(s);
    }
  }

  for (const rel of [...prompts].sort()) {
    const src = path.join(t.coreRoot, "workflows", rel);
    if (!fs.existsSync(src)) continue; // overlay-only prompt, nothing to fork
    results.push(copyFile(src, path.join(t.instanceDir, "workflows", rel), `workflows/${rel}`, force));
  }

  for (const skill of [...skillNames].sort()) {
    let src: string;
    try {
      src = resolveSkillPaths([skill])[0];
    } catch {
      continue; // overlay-only or missing skill
    }
    results.push(copyDir(src, path.join(t.instanceDir, "skills", skill), `skills/${skill}/`, force));
  }

  return results;
}

/** Copy one or more agent-context files (soul.md / rules.md / security.md). */
function forkAgentContext(t: ForkTarget, files: string[], force: boolean): CopyResult[] {
  return files.map((file) => {
    const src = path.join(t.coreRoot, "agent-context", file);
    return copyFile(src, path.join(t.instanceDir, "agent-context", file), `agent-context/${file}`, force);
  });
}

/** Built-in agent-context filenames (e.g. soul.md, rules.md, security.md). */
function builtinAgentContext(coreRoot: string): string[] {
  const dir = path.join(coreRoot, "agent-context");
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
}

// ── reporting ──────────────────────────────────────────────────────────────

function printSummary(t: ForkTarget, results: CopyResult[]): void {
  const sym: Record<Action, string> = {
    copied: chalk.green("＋ copied"),
    overwritten: chalk.yellow("↻ overwritten"),
    skipped: chalk.dim("• skipped (exists)"),
  };
  console.log(chalk.bold(`Forked into ${t.instanceDir}\n`));
  for (const r of results) {
    console.log(`  ${sym[r.action]}  ${r.rel}`);
  }
  const copied = results.filter((r) => r.action !== "skipped").length;
  const skipped = results.length - copied;
  console.log(
    chalk.dim(
      `\n${copied} written, ${skipped} skipped.` +
        (skipped ? "  Re-run with --force to overwrite." : ""),
    ),
  );
  console.log(
    chalk.dim("\nNext: edit the files in instance/, commit the overlay, then ") +
      chalk.cyan("lastlight server restart agent") +
      chalk.dim("."),
  );
}

/** `lastlight fork` with no target — list forkable workflows + context files. */
function listForkable(t: ForkTarget): void {
  configureWorkflowAssets({ builtInRoot: t.coreRoot });
  const forked = new Set(
    enumerateOverlayAssets({ coreRoot: t.coreRoot, overlayRoot: t.instanceDir }).map((a) => `${a.type}:${a.name}`),
  );
  const mark = (key: string): string => (forked.has(key) ? chalk.green(" (forked)") : "");

  console.log(chalk.bold("Forkable workflows") + chalk.dim(`  →  ${t.instanceDir}\n`));
  for (const def of [...listAgentWorkflows()].sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${def.name}${mark(`workflow:${def.name}`)}`);
  }
  const context = builtinAgentContext(t.coreRoot);
  if (context.length) {
    console.log(chalk.bold("\nForkable agent-context") + chalk.dim("  (lastlight fork agent-context)\n"));
    for (const file of context) console.log(`  ${file}${mark(`agent-context:${file}`)}`);
  }
  console.log(chalk.dim("\nFork one with: ") + chalk.cyan("lastlight fork <name>"));
}

// ── entry point ────────────────────────────────────────────────────────────

/**
 * `lastlight fork [target] [sub]` — dispatch on an explicit target.
 *   - (none)                       → list forkable targets
 *   - "agent-context" [file]       → all context files, or one named file
 *   - "<workflow>"                 → workflow + its prompts + skills
 * Agent-context is never inferred from a bare filename — it's only reached via
 * the literal `agent-context` target.
 */
export async function fork(args: string[], opts: ForkOpts): Promise<void> {
  const [target, sub] = args;
  const t = resolveForkTarget(opts);
  if (!hasBuiltins(t.coreRoot)) {
    console.error(
      chalk.red(`No lastlight checkout at ${t.coreRoot} (expected workflows/ + skills/).`) +
        chalk.dim(`\n  Run from a checkout, pass --home <dir>, or set up the server home first.`),
    );
    process.exit(1);
  }

  if (!target) {
    listForkable(t);
    return;
  }

  configureWorkflowAssets({ builtInRoot: t.coreRoot });

  // agent-context — `fork agent-context [file]`. All files, or one named file.
  if (target === "agent-context") {
    const available = builtinAgentContext(t.coreRoot);
    if (!available.length) { console.error(chalk.red("No agent-context files found.")); process.exit(1); }
    let files = available;
    if (sub) {
      const file = sub.endsWith(".md") ? sub : `${sub}.md`;
      if (!available.includes(file)) {
        console.error(chalk.red(`Unknown agent-context file: ${sub}`) + chalk.dim(`\n  Available: ${available.join(", ")}`));
        process.exit(1);
      }
      files = [file];
    }
    printSummary(t, forkAgentContext(t, files, opts.force ?? false));
    return;
  }

  // Otherwise treat it as a workflow name.
  try {
    getWorkflow(target);
  } catch {
    const names = listAgentWorkflows().map((d) => d.name).sort();
    console.error(
      chalk.red(`Unknown fork target: ${target}`) +
        chalk.dim(`\n  Workflows: ${names.join(", ")}`) +
        chalk.dim(`\n  Agent-context: "agent-context" (optionally a file, e.g. agent-context soul.md).`),
    );
    process.exit(1);
  }
  printSummary(t, forkWorkflow(t, target, opts.force ?? false));
}
