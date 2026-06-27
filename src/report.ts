/**
 * Scorecard rendering + SWE-bench-compatible artifacts.
 *
 *  - A stdout table comparing models on resolved% / triage-correct% / tokens /
 *    cost / latency.
 *  - `scorecard.json`  — the structured roll-up.
 *  - `predictions.jsonl` — SWE-bench predictions shape
 *    (`{ instance_id, model_name_or_path, model_patch }`), so the same artifact
 *    is consumable by SWE-bench's own harness.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InstanceResult } from "./schema.js";

export interface Scorecard {
  models: ModelSummary[];
  results: InstanceResult[];
}

export interface ModelSummary {
  model: string;
  total: number;
  codeFixResolved: number;
  codeFixTotal: number;
  behavioralOk: number;
  behavioralTotal: number;
  avgInputTokens: number;
  avgCachedTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
  p50DurationMs: number;
  errors: number;
}

/**
 * Fold N trials of ONE case (same model + instance) into a single result:
 *   - binary verdicts (behavioral / resolved) are WORST-case — true only if
 *     every non-errored trial passed (a reliability measure), with the pass
 *     count kept alongside for variance.
 *   - cost / tokens / latency are the MEAN across non-errored trials.
 * A single trial is returned unchanged. If every trial errored, the aggregate
 * carries that error.
 */
export function aggregateTrials(trials: InstanceResult[]): InstanceResult {
  if (trials.length === 1) return trials[0];
  const base = trials[0];
  const ok = trials.filter((t) => !t.error);
  if (!ok.length) {
    return { ...base, trials: 0, trialErrors: trials.length, error: base.error ?? "all trials errored" };
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const out: InstanceResult = {
    ...base,
    error: undefined,
    inputTokens: Math.round(mean(ok.map((t) => t.inputTokens))),
    cachedTokens: Math.round(mean(ok.map((t) => t.cachedTokens))),
    outputTokens: Math.round(mean(ok.map((t) => t.outputTokens))),
    costUsd: mean(ok.map((t) => t.costUsd)),
    durationMs: Math.round(mean(ok.map((t) => t.durationMs))),
    githubMutations: Math.round(mean(ok.map((t) => t.githubMutations ?? 0))),
    trials: ok.length,
    trialErrors: trials.length - ok.length,
  };

  // behavioral: worst-case ok, checks AND'd by name, keep a failing detail.
  if (ok.some((t) => t.behavioral)) {
    const passes = ok.filter((t) => t.behavioral?.ok).length;
    const names = [...new Set(ok.flatMap((t) => t.behavioral?.checks.map((c) => c.name) ?? []))];
    const checks = names.map((name) => {
      const perTrial = ok.map((t) => t.behavioral?.checks.find((c) => c.name === name));
      const failing = perTrial.find((c) => c && !c.ok);
      return { name, ok: perTrial.every((c) => c?.ok), detail: failing?.detail };
    });
    out.behavioral = { ok: passes === ok.length, checks };
    out.behavioralPass = passes;
  }

  // resolved: worst-case; keep a failing trial's test breakdown + a patch.
  if (ok.some((t) => t.resolved !== undefined)) {
    const passes = ok.filter((t) => t.resolved).length;
    const rep = ok.find((t) => !t.resolved) ?? ok[0];
    out.resolved = passes === ok.length;
    out.resolvedPass = passes;
    out.failToPass = rep.failToPass;
    out.passToPass = rep.passToPass;
    out.model_patch = (ok.find((t) => t.resolved) ?? ok[0]).model_patch;
  }

  return out;
}

/** Per-model aggregation over a set of results (one tier or all of them). */
export function summarizeModels(results: InstanceResult[]): ModelSummary[] {
  const byModel = new Map<string, InstanceResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const models: ModelSummary[] = [];
  for (const [model, list] of byModel) {
    const codeFix = list.filter((r) => r.resolved !== undefined);
    const behavioral = list.filter((r) => r.behavioral !== undefined && !r.error);
    const durations = list.map((r) => r.durationMs).sort((a, b) => a - b);
    models.push({
      model,
      total: list.length,
      codeFixResolved: codeFix.filter((r) => r.resolved).length,
      codeFixTotal: codeFix.length,
      behavioralOk: behavioral.filter((r) => r.behavioral?.ok).length,
      behavioralTotal: behavioral.length,
      avgInputTokens: avg(list.map((r) => r.inputTokens)),
      avgCachedTokens: avg(list.map((r) => r.cachedTokens)),
      avgOutputTokens: avg(list.map((r) => r.outputTokens)),
      totalCostUsd: list.reduce((s, r) => s + r.costUsd, 0),
      p50DurationMs: durations[Math.floor(durations.length / 2)] ?? 0,
      errors: list.filter((r) => r.error).length,
    });
  }
  return models;
}

export function summarize(results: InstanceResult[]): Scorecard {
  return { models: summarizeModels(results), results };
}

export function renderTable(card: Scorecard, labels: Record<string, string> = {}): string {
  const header = ["model", "code-fix", "behavioral", "in tok", "cached", "out tok", "cost $", "p50", "err"];
  const rows = card.models.map((m) => [
    labels[m.model] ?? m.model,
    m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—",
    m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—",
    fmtTokens(m.avgInputTokens),
    fmtTokens(m.avgCachedTokens),
    fmtTokens(m.avgOutputTokens),
    m.totalCostUsd.toFixed(4),
    fmtMs(m.p50DurationMs),
    String(m.errors),
  ]);
  return table([header, ...rows]);
}

export function writeArtifacts(dir: string, card: Scorecard): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(card, null, 2));
  const preds = card.results
    .filter((r) => r.model_patch !== undefined)
    .map((r) => JSON.stringify({ instance_id: r.instance_id, model_name_or_path: r.model, model_patch: r.model_patch ?? "" }))
    .join("\n");
  writeFileSync(join(dir, "predictions.jsonl"), preds ? preds + "\n" : "");
}

// ── helpers ─────────────────────────────────────────────────────────────────

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
/** Compact token count: <1000 verbatim, else "k" (one decimal under 10k).
 * Tolerates undefined/NaN (e.g. a scorecard.json predating cached-token
 * tracking) → "0". */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}
function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
}
