#!/usr/bin/env node
/**
 * Eval runner (a measurement, not a test).
 *
 * Drives the REAL production workflows (issue-triage / build / …) against a
 * fake GitHub for each model under test, grades deterministically, and prints
 * a model-comparison scorecard + writes SWE-bench-compatible artifacts. It
 * exits non-zero only if the HARNESS itself errors — never because a model
 * scored poorly (that's the signal we're measuring).
 *
 * Run:
 *   npm run eval                       # triage tier, default model
 *   npm run eval -- code-fix           # code-fix tier
 *   npm run eval -- triage code-fix    # both
 *   EVAL_MODELS="openai/gpt-5.5,openai/gpt-5.4-mini" npm run eval
 *
 * The deterministic, AI-free plumbing is covered separately by
 * `evals/mechanism.test.ts` in the normal `npm test` suite.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import * as p from "@clack/prompts";
import chalk from "chalk";

import { loadDotEnv, hasProviderKey, evalModels, compareModels, modelLabels, resolveModel, setModelsPath } from "./env.js";
import { runInstance, applyEvalEnv } from "./run-instance.js";
import { summarize, writeArtifacts, aggregateTrials, type Scorecard } from "./report.js";
import { writeHtml, type HtmlMeta } from "./html-report.js";
import type { SweBenchInstance, InstanceResult } from "./schema.js";
import { bootstrapAssets } from "./bootstrap.js";
import { discoverTiers, loadInstances, workflowFor, type Tier } from "./discovery.js";
import { builtinDatasetsRoot, resultsRoot } from "./paths.js";
import { runInit } from "./init.js";

/** Open a file in the OS default browser (best-effort, never throws). */
function openInBrowser(file: string): void {
  const url = `file://${file}`;
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* headless / no browser — the path is printed anyway */
  }
}

/**
 * Run `fn` with `console.*` captured into a buffer so the deep workflow chatter
 * (`[executor] …`, octokit deprecation warnings) doesn't shred the clack
 * spinner — which writes via `process.stdout.write`, a different channel. The
 * captured logs are returned so we can replay them only when a run errors.
 */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const buf: string[] = [];
  const cap =
    (orig: (...a: unknown[]) => void) =>
    (...a: unknown[]) => {
      buf.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
      void orig;
    };
  const { log, warn, error, info } = console;
  console.log = cap(log);
  console.warn = cap(warn);
  console.error = cap(error);
  console.info = cap(info);
  try {
    return { value: await fn(), logs: buf.join("\n") };
  } finally {
    Object.assign(console, { log, warn, error, info });
  }
}

function fmtMs(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

/** Friendly provider-family name from an env-key (OPENAI_API_KEY → "openai"). */
function familyLabel(envKey: string): string {
  return envKey.replace(/_API_KEY$/i, "").toLowerCase() || "default";
}

/**
 * Silence `console.*` for the whole batch (parallel mode). The per-run
 * `quiet()` swap saves/restores console and would corrupt under concurrent
 * runs (nested swaps), so parallel mode drops console output once instead.
 * The clack spinner is untouched — it writes via `process.stdout.write`.
 */
function silenceConsole(): () => void {
  const { log, warn, error, info } = console;
  const sink = () => {};
  Object.assign(console, { log: sink, warn: sink, error: sink, info: sink });
  return () => Object.assign(console, { log, warn, error, info });
}

/** Colored one-line verdict for a finished run (with N/N pass count if N>1). */
function verdictLine(tierName: string, inst: SweBenchInstance, r: InstanceResult): string {
  const head = `${chalk.cyan(tierName)}/${inst.instance_id}`;
  if (r.error) return `${head}  ${chalk.red("harness error")}`;
  const count = (pass?: number) => (pass !== undefined && r.trials ? chalk.dim(` ${pass}/${r.trials}`) : "");
  const parts: string[] = [];
  if (r.resolved !== undefined)
    parts.push((r.resolved ? chalk.green("resolved") : chalk.red("unresolved")) + count(r.resolvedPass));
  if (r.behavioral)
    parts.push((r.behavioral.ok ? chalk.green("behavioral ✓") : chalk.red("behavioral ✗")) + count(r.behavioralPass));
  parts.push(chalk.dim(`$${r.costUsd.toFixed(4)}`));
  parts.push(chalk.dim(fmtMs(r.durationMs)));
  return `${head}  ${parts.join("  ")}`;
}

/** Parse an integer CLI flag (`--name N` or `--name=N`) or `EVAL_NAME` env. */
function intFlag(name: string, def: number): number {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      const n = parseInt(argv[i + 1] ?? "", 10);
      if (n > 0) return n;
    }
    const m = argv[i].match(new RegExp(`^--${name}=(\\d+)$`));
    if (m) return parseInt(m[1], 10);
  }
  const env = parseInt(process.env[`EVAL_${name.toUpperCase()}`] ?? "", 10);
  return env > 0 ? env : def;
}

/** Parse a string CLI flag (`--name V` or `--name=V`) or `EVAL_NAME` env. */
function strFlag(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined) return argv[i + 1];
    const m = argv[i].match(new RegExp(`^--${name}=(.+)$`));
    if (m) return m[1];
  }
  return process.env[`EVAL_${name.toUpperCase()}`];
}

/** CLI flags that take a following value (so it isn't read as a tier name). */
const VALUE_FLAGS = new Set(["--runs", "--model", "--models", "--overlay", "--datasets", "--models-file"]);

async function runEval(): Promise<number> {
  loadDotEnv();
  p.intro(chalk.bold(`Last Light ${chalk.yellow("·")} eval`));

  // Asset roots FIRST — before any getWorkflow/runWorkflow. `--overlay` (or
  // LASTLIGHT_OVERLAY_DIR) layers a deployment's own workflows/skills over the
  // built-ins, and also contributes its `evals/datasets/` (see discovery).
  const overlayDir = strFlag("overlay") ?? process.env.LASTLIGHT_OVERLAY_DIR;
  bootstrapAssets({ overlayDir });

  // A user/overlay can ship its own model registry too: explicit --models-file
  // wins, else an overlay's `evals/models.json` if present, else the built-in.
  const overlayModels = overlayDir ? join(overlayDir, "evals", "models.json") : undefined;
  const modelsFile = strFlag("models-file") ?? (overlayModels && existsSync(overlayModels) ? overlayModels : undefined);
  if (modelsFile) setModelsPath(modelsFile);

  // Discover tiers across built-in + user (--datasets) + overlay roots.
  const userDatasetsDir = strFlag("datasets") ?? process.env.LASTLIGHT_EVALS_DATASETS;
  const discovered = discoverTiers({
    builtinRoot: builtinDatasetsRoot(),
    userDatasetsDir,
    overlayDir,
  });

  if (!hasProviderKey()) {
    p.log.error(
      "No provider key found. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY / OPENROUTER_API_KEY)\n" +
        "in your environment or .env, then re-run `npm run eval`.",
    );
    p.outro(chalk.red("aborted"));
    return 1;
  }

  const compare = process.argv.includes("--compare");
  const noOpen = process.argv.includes("--no-open") || !!process.env.CI;
  const runs = intFlag("runs", 1);

  // Positional tier names — skip flags AND the values that follow value-flags.
  const argv = process.argv.slice(2);
  const requested: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) {
      i++; // its value isn't a tier
      continue;
    }
    if (!argv[i].startsWith("-")) requested.push(argv[i]);
  }

  const known = [...discovered.keys()];
  if (!known.length) {
    p.log.error(
      "No datasets found. The package ships `triage`/`code-fix`; add your own via\n" +
        "--datasets <dir> (or LASTLIGHT_EVALS_DATASETS), or --overlay <repo> with an\n" +
        "`evals/datasets/` folder.",
    );
    p.outro(chalk.red("aborted"));
    return 1;
  }
  const defaultTier = known.includes("triage") ? "triage" : known[0];

  // Tiers come from argv when given; otherwise ask interactively (one or all).
  // Non-interactive (CI / piped stdin) falls back to the cheapest default
  // so automation never blocks on a prompt.
  let chosen: string[];
  if (requested.length) {
    chosen = requested;
  } else if (process.stdin.isTTY) {
    const picked = await p.multiselect({
      message: "Which tiers to run?",
      options: known.map((name) => ({
        value: name,
        label: name + (discovered.get(name)!.source !== "builtin" ? chalk.dim(` (${discovered.get(name)!.source})`) : ""),
        hint: discovered.get(name)!.description,
      })),
      initialValues: [defaultTier],
      required: true,
    });
    if (p.isCancel(picked)) {
      p.cancel("aborted");
      return 1;
    }
    chosen = picked as string[];
  } else {
    chosen = [defaultTier];
  }

  // Stable display order (discovery order) regardless of pick order.
  const tiers = known.filter((t) => chosen.includes(t));
  for (const t of chosen) {
    if (!discovered.has(t)) p.log.warn(`Unknown tier "${t}". Known: ${known.join(", ")}`);
  }

  // Model selection precedence:
  //   1. --model / --models (or EVAL_MODEL[S]) — an explicit list, fuzzy-matched
  //      against models.json; lets you test one model quickly.
  //   2. --compare — the full cross-vendor set (key-gated).
  //   3. default single model from models.json.
  // Each entry carries its provider family (env-key) for parallel grouping.
  const modelArg = strFlag("model") ?? strFlag("models");
  const mode = modelArg ? "select" : compare ? "compare" : "single";
  const entries: { id: string; family: string }[] = modelArg
    ? modelArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((tok) => {
          const r = resolveModel(tok);
          return { id: r.id, family: r.family };
        })
    : compare
      ? compareModels().map((m) => ({ id: m.id, family: m.envKey ?? m.provider ?? "default" }))
      : evalModels().map((id) => ({ id, family: "default" }));
  if (!entries.length) {
    p.log.error(
      "No comparison models available — set provider keys (OPENAI_API_KEY / ANTHROPIC_API_KEY /\n" +
        "FIREWORKS_API_KEY …) for the entries in evals/models.json.",
    );
    p.outro(chalk.red("aborted"));
    return 1;
  }
  const labels = modelLabels();

  interface WorkItem {
    tierName: string;
    defaultWorkflow: string;
    datasetDir: string;
    model: string;
    family: string;
    inst: SweBenchInstance;
  }

  // Resolve the work-list up front so we can show deterministic progress.
  const work: WorkItem[] = [];
  for (const tierName of tiers) {
    const tier: Tier = discovered.get(tierName)!;
    const instances = loadInstances(tier);
    if (!instances.length) {
      p.log.warn(`tier "${tierName}": no instances at ${tier.instancesPath} — skipping`);
      continue;
    }
    for (const e of entries) {
      for (const inst of instances) {
        // Per-instance workflow wins, else the tier's defaultWorkflow (throws if
        // neither is set — surfaced as a harness error for that case).
        work.push({
          tierName,
          defaultWorkflow: workflowFor(tier, inst),
          datasetDir: tier.root,
          model: e.id,
          family: e.family,
          inst,
        });
      }
    }
  }

  if (!work.length) {
    p.log.error("Nothing to run — no datasets matched the requested tiers.");
    p.outro(chalk.red("aborted"));
    return 1;
  }

  // Group work by provider family. Families run CONCURRENTLY (independent
  // provider keys / rate limits); within a family runs stay serial. Force
  // serial with --serial or when there's only one family.
  const byFamily = new Map<string, WorkItem[]>();
  for (const w of work) {
    const arr = byFamily.get(w.family);
    if (arr) arr.push(w);
    else byFamily.set(w.family, [w]);
  }
  const parallel = !process.argv.includes("--serial") && byFamily.size > 1;

  const resultsDir = join(resultsRoot(), `${tiers.join("+")}${compare ? "-compare" : ""}`);
  const htmlBase: Omit<HtmlMeta, "live" | "progress" | "generatedAt"> = {
    models: entries.map((e) => labels[e.id] ?? e.id),
    tiers,
    labels,
    runs,
  };

  p.note(
    `${chalk.bold("mode")}    ${mode}${
      parallel ? chalk.dim(` (parallel · ${byFamily.size} families)`) : ""
    }\n` +
      `${chalk.bold("models")}  ${entries.map((e) => labels[e.id] ?? e.id).join(", ")}\n` +
      `${chalk.bold("tiers")}   ${tiers.join(", ")}\n` +
      `${chalk.bold("cases")}   ${work.length}${
        runs > 1
          ? chalk.dim(` × ${runs} trials = ${work.length * runs} runs · worst-case verdict, mean cost`)
          : ""
      }`,
    "plan",
  );

  // `total` counts individual trials so live progress advances per model call.
  const total = work.length * runs;

  // Open the report immediately (live placeholder) so it fills in as we go.
  writeHtml(resultsDir, summarize([]), { ...htmlBase, generatedAt: new Date().toISOString(), live: true, progress: `0/${total}` });
  const htmlFile = join(resultsDir, "index.html");
  if (!noOpen) {
    openInBrowser(htmlFile);
    p.log.info(`Live report → ${chalk.cyan(htmlFile)} ${chalk.dim("(auto-refreshing)")}`);
  }

  const all: InstanceResult[] = [];
  let harnessErrors = 0;
  let completed = 0;

  // Track in-flight cases so the live report can show running / queued rows.
  const caseKey = (tier: string, model: string, id: string) => `${tier}|${model}|${id}`;
  const running = new Set<string>();

  // writeHtml/summarize/all.push run synchronously to completion inside one
  // event-loop turn, so even with concurrent families they never interleave.
  const refresh = () => {
    const done = new Set(all.map((r) => caseKey(r.tier ?? "", r.model, r.instance_id)));
    const pending = work
      .map((w) => ({ w, k: caseKey(w.tierName, w.model, w.inst.instance_id) }))
      .filter(({ k }) => !done.has(k))
      .map(({ w, k }) => ({
        tier: w.tierName,
        model: w.model,
        instance_id: w.inst.instance_id,
        status: (running.has(k) ? "running" : "pending") as "running" | "pending",
      }));
    writeHtml(resultsDir, summarize(all), {
      ...htmlBase,
      generatedAt: new Date().toISOString(),
      live: true,
      progress: `${completed}/${total}`,
      pending,
    });
  };

  // Run one case `runs` times and fold the trials into a single result
  // (worst-case verdict, mean metrics). `onTrial` ticks per model call.
  const runItem = async (w: WorkItem, onTrial: () => void): Promise<InstanceResult> => {
    const trials: InstanceResult[] = [];
    for (let t = 0; t < runs; t++) {
      const r = await runInstance(w.inst, {
        model: w.model,
        datasetDir: w.datasetDir,
        defaultWorkflow: w.defaultWorkflow,
        manageEnv: false,
      });
      r.tier = w.tierName;
      trials.push(r);
      completed++;
      onTrial();
    }
    return aggregateTrials(trials);
  };

  // Install the eval's static-token env ONCE for the whole batch so concurrent
  // runs share one stable baseline (manageEnv:false on every runInstance).
  const restoreEvalEnv = applyEvalEnv();
  try {
    if (parallel) {
      // Per-family progress for the aggregate spinner line.
      const fam = new Map<string, { done: number; total: number }>();
      for (const [f, items] of byFamily) fam.set(f, { done: 0, total: items.length * runs });
      const status = () => {
        const segs = [...fam].map(([f, c]) => {
          const done = c.done === c.total ? chalk.green(`${c.done}/${c.total}`) : `${c.done}/${c.total}`;
          return `${familyLabel(f)} ${done}`;
        });
        return `${chalk.dim(`${completed}/${total}`)}  ${segs.join(chalk.dim(" · "))}`;
      };
      const s = p.spinner();
      s.start(status());
      const restoreConsole = silenceConsole();
      const verdicts: string[] = [];
      try {
        await Promise.all(
          [...byFamily].map(async ([f, items]) => {
            for (const w of items) {
              const k = caseKey(w.tierName, w.model, w.inst.instance_id);
              running.add(k);
              refresh();
              const result = await runItem(w, () => {
                fam.get(f)!.done++;
                s.message(status());
                refresh();
              });
              running.delete(k);
              all.push(result);
              if (result.error) harnessErrors++;
              const mark = result.error ? chalk.red("✗") : chalk.green("✓");
              verdicts.push(`${mark} ${chalk.dim(familyLabel(f))}  ${verdictLine(w.tierName, w.inst, result)}`);
              refresh();
            }
          }),
        );
      } finally {
        restoreConsole();
      }
      s.stop(`${chalk.dim(`${completed}/${total}`)} ${chalk.green("done")}`);
      p.log.message(verdicts.join("\n"));
    } else {
      // Serial: one spinner per case (updates per trial) + a verdict line.
      for (let i = 0; i < work.length; i++) {
        const w = work[i];
        const s = p.spinner();
        const head = `${chalk.dim(`[${i + 1}/${work.length}]`)} ${chalk.cyan(w.tierName)}/${w.inst.instance_id}  ${chalk.dim(labels[w.model] ?? w.model)}`;
        s.start(head);

        const k = caseKey(w.tierName, w.model, w.inst.instance_id);
        running.add(k);
        refresh();
        let t = 0;
        const { value: result, logs } = await quiet(() =>
          runItem(w, () => {
            t++;
            if (runs > 1) s.message(`${head}  ${chalk.dim(`trial ${t}/${runs}`)}`);
            refresh();
          }),
        );
        running.delete(k);
        all.push(result);
        if (result.error) harnessErrors++;

        const mark = result.error ? chalk.red("✗") : chalk.green("✓");
        s.stop(`${chalk.dim(`[${i + 1}/${work.length}]`)} ${mark} ${verdictLine(w.tierName, w.inst, result)}`);
        if (result.error) {
          p.log.error(chalk.dim(result.error));
          const tail = logs.split("\n").filter(Boolean).slice(-12).join("\n");
          if (tail) p.log.message(chalk.dim(tail));
        }
        refresh();
      }
    }
  } finally {
    restoreEvalEnv();
  }

  // Final, static report + machine artifacts.
  const card = summarize(all);
  writeArtifacts(resultsDir, card);
  const html = writeHtml(resultsDir, card, { ...htmlBase, generatedAt: new Date().toISOString() });

  p.log.success(`Scorecard → ${chalk.cyan(html)}`);
  p.log.success(`Artifacts → ${chalk.cyan(resultsDir)}/{scorecard.json,predictions.jsonl}`);

  const ran = runs > 1 ? `${completed} runs (${all.length} cases × ${runs})` : `${all.length} runs`;
  if (harnessErrors > 0) {
    p.outro(chalk.yellow(`done — ${ran}, ${harnessErrors} harness error${harnessErrors === 1 ? "" : "s"} (see above)`));
  } else {
    p.outro(chalk.green(`done — ${ran}, report at ${html}`));
  }

  // Non-zero ONLY on harness failure — model quality is the measurement.
  return harnessErrors > 0 ? 1 : 0;
}

/**
 * `report <dir>` — re-render `<dir>/index.html` from an existing
 * `<dir>/scorecard.json`, no models run. Lets you regenerate the HTML after a
 * report-template change (or to re-skin an old run) without paying for a fresh
 * eval. Models/tiers/labels are reconstructed from the scorecard itself.
 */
function runReport(dir?: string): number {
  if (!dir) {
    console.error("usage: lastlight-evals report <results-dir>  (a dir holding scorecard.json)");
    return 1;
  }
  const file = join(dir, "scorecard.json");
  if (!existsSync(file)) {
    console.error(`no scorecard.json in ${dir}`);
    return 1;
  }
  const card = JSON.parse(readFileSync(file, "utf8")) as Scorecard;
  const labels = modelLabels();
  // Tiers/models come straight off the saved results so the re-render matches
  // exactly what that run measured (no dependence on current models.json).
  const tiers = [...new Set(card.results.map((r) => r.tier ?? "triage"))];
  const models = [...new Set(card.results.map((r) => r.model))].map((m) => labels[m] ?? m);
  const runs = Math.max(1, ...card.results.map((r) => r.trials ?? 1));
  const html = writeHtml(dir, card, { models, tiers, labels, runs, generatedAt: new Date().toISOString() });
  console.log(`Scorecard → ${html}`);
  return 0;
}

/** Top-level subcommand dispatcher: `run` (default) | `init` | `report`. */
async function main(): Promise<number> {
  const sub = process.argv[2];
  if (sub === "init") {
    // `init [dir]` — scaffold a fresh overlay+evals repo.
    return runInit(process.argv[3]);
  }
  if (sub === "report") {
    // `report <dir>` — re-render index.html from a saved scorecard.json.
    return runReport(process.argv[3]);
  }
  // `run` is the default; allow an explicit leading `run` token too.
  if (sub === "run") process.argv.splice(2, 1);
  return runEval();
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
