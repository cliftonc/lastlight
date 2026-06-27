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

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import * as p from "@clack/prompts";
import chalk from "chalk";

import { loadDotEnv, hasProviderKey, evalModels, compareModels, modelLabels } from "./env.js";
import { runInstance, applyEvalEnv } from "./run-instance.js";
import { summarize, renderTable, writeArtifacts } from "./report.js";
import { writeHtml, type HtmlMeta } from "./html-report.js";
import type { SweBenchInstance, InstanceResult } from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

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

/** Colored one-line verdict for a finished run. */
function verdictLine(tierName: string, inst: SweBenchInstance, r: InstanceResult): string {
  const head = `${chalk.cyan(tierName)}/${inst.instance_id}`;
  if (r.error) return `${head}  ${chalk.red("harness error")}`;
  const parts: string[] = [];
  if (r.resolved !== undefined) parts.push(r.resolved ? chalk.green("resolved") : chalk.red("unresolved"));
  if (r.behavioral) parts.push(r.behavioral.ok ? chalk.green("behavioral ✓") : chalk.red("behavioral ✗"));
  parts.push(chalk.dim(`$${r.costUsd.toFixed(4)}`));
  parts.push(chalk.dim(fmtMs(r.durationMs)));
  return `${head}  ${parts.join("  ")}`;
}

interface Tier {
  name: string;
  defaultWorkflow: string;
}
const TIERS: Record<string, Tier> = {
  triage: { name: "triage", defaultWorkflow: "issue-triage" },
  "code-fix": { name: "code-fix", defaultWorkflow: "build" },
};

function loadInstances(tier: string): SweBenchInstance[] {
  const file = join(HERE, "datasets", tier, "instances.json");
  if (!existsSync(file)) return [];
  const all = JSON.parse(readFileSync(file, "utf8")) as SweBenchInstance[];
  // Optional substring filter for focused debugging: EVAL_INSTANCE=off-by-one
  const filter = process.env.EVAL_INSTANCE?.trim();
  return filter ? all.filter((i) => i.instance_id.includes(filter)) : all;
}

async function main(): Promise<number> {
  loadDotEnv();
  p.intro(chalk.bold(`Last Light ${chalk.yellow("·")} eval`));

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
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));

  // Tiers come from argv when given; otherwise ask interactively (one or all).
  // Non-interactive (CI / piped stdin) falls back to the cheap triage default
  // so automation never blocks on a prompt.
  let chosen: string[];
  if (requested.length) {
    chosen = requested;
  } else if (process.stdin.isTTY) {
    const picked = await p.multiselect({
      message: "Which tiers to run?",
      options: [
        { value: "triage", label: "triage", hint: "cheap · issue-triage workflow" },
        { value: "code-fix", label: "code-fix", hint: "heavy · full build cycle" },
      ],
      initialValues: ["triage"],
      required: true,
    });
    if (p.isCancel(picked)) {
      p.cancel("aborted");
      return 1;
    }
    chosen = picked as string[];
  } else {
    chosen = ["triage"];
  }

  // Canonical order (triage tab before code-fix) regardless of pick order.
  const tiers = Object.keys(TIERS).filter((t) => chosen.includes(t));
  for (const t of chosen) {
    if (!TIERS[t]) p.log.warn(`Unknown tier "${t}". Known: ${Object.keys(TIERS).join(", ")}`);
  }

  // Single-model run by default; `--compare` fans out across models.json's set
  // (only the ones whose provider key is present). Each entry carries its
  // provider family (the env-key) so we can parallelize across providers.
  const entries: { id: string; family: string }[] = compare
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
    const tier = TIERS[tierName];
    const datasetDir = join(HERE, "datasets", tierName);
    const instances = loadInstances(tierName);
    if (!instances.length) {
      p.log.warn(`tier "${tierName}": no instances at ${datasetDir} — skipping`);
      continue;
    }
    for (const e of entries) {
      for (const inst of instances) {
        work.push({ tierName, defaultWorkflow: tier.defaultWorkflow, datasetDir, model: e.id, family: e.family, inst });
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

  const resultsDir = join(HERE, "results", `${tiers.join("+")}${compare ? "-compare" : ""}`);
  const htmlBase: Omit<HtmlMeta, "live" | "progress" | "generatedAt"> = {
    models: entries.map((e) => labels[e.id] ?? e.id),
    tiers,
    labels,
  };

  p.note(
    `${chalk.bold("mode")}    ${compare ? "compare" : "single"}${
      parallel ? chalk.dim(` (parallel · ${byFamily.size} families)`) : ""
    }\n` +
      `${chalk.bold("models")}  ${entries.map((e) => labels[e.id] ?? e.id).join(", ")}\n` +
      `${chalk.bold("tiers")}   ${tiers.join(", ")}\n` +
      `${chalk.bold("runs")}    ${work.length}`,
    "plan",
  );

  // Open the report immediately (live placeholder) so it fills in as we go.
  const total = work.length;
  writeHtml(resultsDir, summarize([]), { ...htmlBase, generatedAt: new Date().toISOString(), live: true, progress: `0/${total}` });
  const htmlFile = join(resultsDir, "index.html");
  if (!noOpen) {
    openInBrowser(htmlFile);
    p.log.info(`Live report → ${chalk.cyan(htmlFile)} ${chalk.dim("(auto-refreshing)")}`);
  }

  const all: InstanceResult[] = [];
  let harnessErrors = 0;
  let completed = 0;

  // writeHtml/summarize/all.push run synchronously to completion inside one
  // event-loop turn, so even with concurrent families they never interleave.
  const refresh = () =>
    writeHtml(resultsDir, summarize(all), {
      ...htmlBase,
      generatedAt: new Date().toISOString(),
      live: true,
      progress: `${completed}/${total}`,
    });

  // Install the eval's static-token env ONCE for the whole batch so concurrent
  // runs share one stable baseline (manageEnv:false on every runInstance).
  const restoreEvalEnv = applyEvalEnv();
  try {
    if (parallel) {
      // Per-family progress for the aggregate spinner line.
      const fam = new Map<string, { done: number; total: number }>();
      for (const [f, items] of byFamily) fam.set(f, { done: 0, total: items.length });
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
              const result = await runInstance(w.inst, {
                model: w.model,
                datasetDir: w.datasetDir,
                defaultWorkflow: w.defaultWorkflow,
                manageEnv: false,
              });
              result.tier = w.tierName;
              all.push(result);
              if (result.error) harnessErrors++;
              completed++;
              fam.get(f)!.done++;
              const mark = result.error ? chalk.red("✗") : chalk.green("✓");
              verdicts.push(`${mark} ${chalk.dim(familyLabel(f))}  ${verdictLine(w.tierName, w.inst, result)}`);
              s.message(status());
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
      // Serial: one spinner per run with a live verdict line + captured logs.
      for (let i = 0; i < work.length; i++) {
        const { tierName, defaultWorkflow, datasetDir, model, inst } = work[i];
        const n = i + 1;
        const s = p.spinner();
        s.start(`${chalk.dim(`[${n}/${total}]`)} ${chalk.cyan(tierName)}/${inst.instance_id}  ${chalk.dim(labels[model] ?? model)}`);

        const { value: result, logs } = await quiet(() =>
          runInstance(inst, { model, datasetDir, defaultWorkflow, manageEnv: false }),
        );
        result.tier = tierName;
        all.push(result);
        if (result.error) harnessErrors++;
        completed++;

        const mark = result.error ? chalk.red("✗") : chalk.green("✓");
        s.stop(`${chalk.dim(`[${n}/${total}]`)} ${mark} ${verdictLine(tierName, inst, result)}`);
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

  p.note(renderTable(card, labels), "scorecard");
  p.log.success(`Artifacts → ${chalk.cyan(resultsDir)}/{scorecard.json,predictions.jsonl,index.html}`);

  if (harnessErrors > 0) {
    p.outro(chalk.yellow(`done — ${harnessErrors} harness error${harnessErrors === 1 ? "" : "s"} (see above)`));
  } else {
    p.outro(chalk.green(`done — ${all.length} runs, report at ${html}`));
  }

  // Non-zero ONLY on harness failure — model quality is the measurement.
  return harnessErrors > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
