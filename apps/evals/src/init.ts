/**
 * `lastlight-evals init [dir]` — scaffold an eval workspace, in one of two shapes.
 *
 * 1. **Plain** (`init [dir]`) — a self-contained overlay+evals repo: it carries
 *    its own `workflows/` / `skills/` / `agent-context/` (which shadow the
 *    built-ins by logical name) AND its own `evals/datasets/` + `evals/models.json`.
 *    Run it with `--overlay .`. Offered git/GitHub bootstrap via core's
 *    `detectGh` + `bootstrapOverlayRepo`.
 *
 * 2. **Separate** (`init [dir] --clone <owner/repo>`) — the recommended shape
 *    when you already have a deployment overlay repo (e.g. `lastlight-instance`).
 *    The overlay is cloned into `<dir>/instance/` (its own git checkout, which
 *    the workspace `.gitignore`s) and the evals live at the workspace root
 *    (`evals/datasets/`, `evals/models.json`). The runner auto-detects `./instance`
 *    as the overlay and the local `./evals/datasets`, so a bare
 *    `lastlight-evals run` from the workspace "just works" — no flags. Evals stay
 *    out of your deployment repo; you `git pull` the overlay in `instance/`.
 *
 * It's pure data/config — no node deps; the globally installed CLI supplies the runtime.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as p from "@clack/prompts";
import chalk from "chalk";
import { detectGh, bootstrapOverlayRepo } from "lastlight-core/evals";

import { builtinDatasetsRoot, builtinModelsPath } from "./paths.js";

const exec = promisify(execFile);

const CONFIG_YAML = `# Last Light — eval/overlay config (merged over the core config/default.yaml).
# Arrays replace, maps deep-merge, env vars override. See the lastlight docs.
#
# managedRepos:
#   - your-org/your-repo
#
# models:
#   default: openai/gpt-5.5
`;

const GITIGNORE = `# Eval run output (scorecards, predictions) — regenerated, never commit.
eval-results/

# Cached clones of git-source eval repos — re-fetched on demand, never commit.
.eval-cache/

# Local secrets / env.
.env
secrets/*
!secrets/.env.example
*.pem
`;

// Entries every eval workspace MUST ignore. `eval-results/` is always required;
// the Separate layout adds `instance/` (a nested overlay checkout). These are
// enforced even when a `.gitignore` already exists (plain init writes the full
// template; clone-into-subdir adds these to whatever the dir already has).
const EVAL_OUTPUT_IGNORE = "eval-results/";
const CACHE_IGNORE = ".eval-cache/";
const INSTANCE_IGNORE = "instance/";

/**
 * Guarantee `.gitignore` exists and ignores `required` entries. Writes the full
 * template when absent; otherwise appends only the lines it's missing
 * (idempotent) so an existing `.gitignore` is preserved but the eval output (and,
 * in the Separate layout, the `instance/` overlay checkout) is never committed.
 */
function ensureGitignore(dir: string, created: string[], required: string[]): void {
  const abs = join(dir, ".gitignore");
  if (!existsSync(abs)) {
    const extra = required.filter((l) => !GITIGNORE.includes(l));
    writeFileSync(abs, extra.length ? `${GITIGNORE}\n${extra.join("\n")}\n` : GITIGNORE, "utf8");
    created.push(".gitignore");
    return;
  }
  const existing = readFileSync(abs, "utf8");
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = required.filter((l) => !have.has(l));
  if (!missing.length) return;
  const sep = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(
    abs,
    `${existing}${sep}\n# Last Light eval workspace — regenerated/checkout artifacts, never commit.\n${missing.join("\n")}\n`,
    "utf8",
  );
  created.push(`.gitignore (added ${missing.join(", ")})`);
}

/** README for the plain (self-overlay) workspace. */
function readmePlain(name: string): string {
  return `# ${name}

A Last Light **eval + overlay** workspace, created by \`lastlight-evals init\`.

## Layout

- \`workflows/\`, \`skills/\`, \`agent-context/\` — overlay assets. Files here
  **shadow** the built-in Last Light assets by name, or add new ones.
- \`evals/datasets/<tier>/\` — your eval datasets (\`instances.json\` +
  \`tier.json\`, plus \`repos/\` + \`tests/\` for code-fix tiers). Seeded with the
  shipped \`triage\` / \`code-fix\` samples — edit or replace them.
- \`evals/models.json\` — the model registry these evals run against.
- \`config.yaml\` — overlay config (managed repos, models, …).

## Run

\`\`\`bash
# from inside this repo
lastlight-evals run --overlay .
# or a specific tier
lastlight-evals run code-fix --overlay .
\`\`\`

Override which core build the evals test with \`LASTLIGHT_CORE_DIR=/path/to/lastlight/apps/server\`.
`;
}

/** README for the Separate layout — overlay checked out in `instance/`. */
function readmeSeparate(name: string, repo: string): string {
  return `# ${name}

A Last Light **eval workspace** created by \`lastlight-evals init --clone ${repo}\`.

The deployment overlay [\`${repo}\`](https://github.com/${repo}) is checked out in
\`instance/\` (its own git repo, \`.gitignore\`d here) and the evals live at the
workspace root. The runner auto-detects \`./instance\` as the overlay and your
local \`./evals/datasets\`, so a bare run "just works".

## Layout

- \`instance/\` — your deployment overlay (config, workflows, skills, persona).
  A separate git checkout — \`cd instance && git pull\` to update it.
- \`evals/datasets/<tier>/\` — eval datasets, seeded with the shipped
  \`triage\` / \`code-fix\` samples. Edit or add tiers here.
- \`evals/models.json\` — the model registry these evals run against.
- \`.env\` — your provider key(s). GitHub is mocked, so no GitHub token is needed.

## Run

\`\`\`bash
lastlight-evals run                 # auto: overlay ./instance + local datasets
lastlight-evals run code-fix        # one tier
lastlight-evals run --compare       # cross-vendor set (key-gated)
\`\`\`

Override which core build the evals test with \`LASTLIGHT_CORE_DIR=/path/to/lastlight/apps/server\`.
`;
}

/** Turn a `--clone` value into a clone URL. Accepts a full URL/scp ref as-is,
 *  else treats `owner/repo` as a GitHub slug. */
function cloneUrl(repo: string): string {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(repo) ? repo : `https://github.com/${repo}.git`;
}

/**
 * Clone an existing overlay repo (e.g. a deployment's `lastlight-instance`) into
 * `target` as its own git checkout. Idempotent — if `target` is already a repo it
 * leaves it untouched (so re-running `init` doesn't reclone). Clones to a temp
 * sibling first and moves the contents in, so a pre-populated `target` keeps its
 * files. Prefers `gh` (handles private-repo auth) and falls back to plain `git`.
 */
async function cloneOverlayInto(target: string, repo: string): Promise<boolean> {
  if (existsSync(join(target, ".git"))) {
    p.log.info(`${chalk.cyan(target)} is already a checkout — skipping clone of ${chalk.bold(repo)} (\`cd instance && git pull\` to update).`);
    return false;
  }
  mkdirSync(target, { recursive: true });
  const tmp = `${target}.clone-tmp`;
  rmSync(tmp, { recursive: true, force: true });
  p.log.step(`Cloning ${chalk.bold(repo)} → ${chalk.cyan(target)}`);
  try {
    await exec("gh", ["repo", "clone", repo, tmp]);
  } catch {
    await exec("git", ["clone", "--quiet", cloneUrl(repo), tmp]);
  }
  // Move cloned entries (including .git) into target, never clobbering what's there.
  for (const entry of readdirSync(tmp)) {
    const dst = join(target, entry);
    if (!existsSync(dst)) renameSync(join(tmp, entry), dst);
  }
  rmSync(tmp, { recursive: true, force: true });
  return true;
}

/**
 * Write the default files/dirs into `dir`, never overwriting what exists.
 * `overlayRepo` set ⇒ Separate layout: the overlay is a cloned `instance/`, so we
 * skip the root `config.yaml` + `workflows/skills/agent-context` placeholders
 * (those belong to — and are read from — `instance/`) and `.gitignore` the
 * checkout. Either way we always seed `evals/datasets/` + `evals/models.json`.
 */
function scaffoldEvalRepo(dir: string, overlayRepo?: string): string[] {
  const created: string[] = [];
  const writeIfMissing = (rel: string, content: string): void => {
    const abs = join(dir, rel);
    if (existsSync(abs)) return;
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
    created.push(rel);
  };

  // Seed datasets + models from the shipped defaults (a starting point to edit).
  // Always created — the workspace's own `evals/datasets/` is what the runner
  // auto-discovers, so it must exist even when the overlay lives in `instance/`.
  const datasetsDst = join(dir, "evals", "datasets");
  if (!existsSync(datasetsDst)) {
    mkdirSync(datasetsDst, { recursive: true });
    cpSync(builtinDatasetsRoot(), datasetsDst, { recursive: true });
    created.push("evals/datasets/ (seeded triage + code-fix)");
  }
  const modelsDst = join(dir, "evals", "models.json");
  if (!existsSync(modelsDst)) {
    cpSync(builtinModelsPath(), modelsDst);
    created.push("evals/models.json");
  }

  if (overlayRepo) {
    // Separate layout — overlay assets + config come from the `instance/` checkout.
    ensureGitignore(dir, created, [EVAL_OUTPUT_IGNORE, CACHE_IGNORE, INSTANCE_IGNORE]);
    writeIfMissing("README.md", readmeSeparate(basename(dir), overlayRepo));
  } else {
    // Plain layout — this repo is its own overlay.
    for (const d of ["workflows", "skills", "agent-context"]) {
      writeIfMissing(join(d, ".gitkeep"), "");
    }
    writeIfMissing("config.yaml", CONFIG_YAML);
    ensureGitignore(dir, created, [EVAL_OUTPUT_IGNORE, CACHE_IGNORE]);
    writeIfMissing("README.md", readmePlain(basename(dir)));
  }
  return created;
}

const INIT_USAGE = `lastlight-evals init [dir] [options]

Scaffold a fresh overlay + evals workspace (seeded triage + code-fix datasets).

Arguments:
  dir              Target directory (default: lastlight-evals-workspace; "." = here)

Options:
  --clone <repo>   Separate layout: clone an existing overlay repo (owner/repo or
                   URL) into <dir>/instance/ (its own checkout, git-ignored) and
                   scaffold evals/ at the root. The runner auto-detects ./instance
                   + ./evals/datasets, so a bare \`lastlight-evals run\` just works.
  --yes, -y        Non-interactive: scaffold without prompting; print the manual
                   git/GitHub commands instead of running them.
  --no-git         Scaffold files only; skip the git/GitHub bootstrap entirely.
  --help, -h       Show this help.

With no TTY (piped/automation), behaves as --yes so it never blocks on a prompt.

Example — point an eval workspace at your deployment overlay:
  lastlight-evals init . --clone your-org/lastlight-instance
  lastlight-evals run`;

/**
 * `init [dir] [flags]`. Parses its own argv slice so it's safe to drive
 * head-less: a leading `--flag` is never mistaken for the target dir, and the
 * interactive git/GitHub bootstrap is skipped when there's no TTY (or when
 * `--yes`/`--no-git` is passed) so an agent or CI run can't hang on a prompt.
 */
export async function runInit(args: string[] = []): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INIT_USAGE);
    return 0;
  }
  const noGit = args.includes("--no-git");
  // Non-interactive when asked (--yes/-y) or whenever stdin isn't a TTY, so
  // automation never blocks on the version-as-repo confirm prompt.
  const yes = args.includes("--yes") || args.includes("-y") || !process.stdin.isTTY;

  // `--clone <repo>` / `--from <repo>` — its value isn't the target dir.
  const valFlag = (...names: string[]): string | undefined => {
    for (let i = 0; i < args.length; i++) {
      const eq = names.find((n) => args[i].startsWith(`${n}=`));
      if (eq) return args[i].slice(eq.length + 1);
      if (names.includes(args[i])) return args[i + 1];
    }
    return undefined;
  };
  const cloneRepo = valFlag("--clone", "--from");
  const dirArg = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--clone" && args[i - 1] !== "--from");

  p.intro(chalk.bold(`Last Light ${chalk.yellow("·")} eval init`));

  const dir = resolve(dirArg ?? "lastlight-evals-workspace");

  // Separate layout: clone the overlay into `<dir>/instance/` (its own checkout),
  // then scaffold the evals at the root with `instance/` git-ignored. The runner
  // auto-detects `./instance` + `./evals/datasets`.
  if (cloneRepo) {
    try {
      await cloneOverlayInto(join(dir, "instance"), cloneRepo);
    } catch (err) {
      p.log.error(`Clone of ${cloneRepo} failed: ${(err as Error).message}`);
      p.outro(chalk.red("aborted"));
      return 1;
    }
  }

  p.log.step(`Scaffolding ${chalk.cyan(dir)}`);
  const created = scaffoldEvalRepo(dir, cloneRepo);
  if (created.length) {
    p.log.success(`Created:\n  ${created.join("\n  ")}`);
  } else {
    p.log.info("Nothing to scaffold — every default file already existed.");
  }

  // Git/GitHub bootstrap (plain layout only — the overlay carries its own repo).
  // `--no-git` skips it; otherwise `yes` forwards core's non-interactive path
  // (scaffolds + prints the manual git/gh commands rather than prompting).
  if (cloneRepo) {
    p.log.info(`Overlay checked out in ${chalk.cyan("instance/")} — ${chalk.dim("cd instance && git pull")} to update it.`);
  } else if (noGit) {
    p.log.info(`Skipped git/GitHub bootstrap (--no-git). Version it yourself with ${chalk.dim("git init")}.`);
  } else {
    try {
      const gh = await detectGh();
      await bootstrapOverlayRepo(dir, { gh, yes });
    } catch (err) {
      p.log.warn(`Skipped git/GitHub bootstrap: ${(err as Error).message}`);
    }
  }

  const here = dir === process.cwd();
  const runCmd = cloneRepo
    ? here
      ? "lastlight-evals run"
      : `cd ${dir} && lastlight-evals run`
    : `lastlight-evals run --overlay ${here ? "." : dir}`;
  p.outro(chalk.green(`done — run it with: ${chalk.bold(runCmd)}`));
  return 0;
}
