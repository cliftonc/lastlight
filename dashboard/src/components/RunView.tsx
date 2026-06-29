import { useState } from "react";

import type { IndexRun, InstanceResult, PendingCase } from "../types";
import { useScorecard } from "../lib/api";
import { fmtDate, modelLabel } from "../lib/format";
import { summarizeModels } from "../lib/summarize";
import { CompareTable } from "./CompareTable";
import { InstanceTable } from "./InstanceTable";

/** One run's full scorecard: tier tabs, each with a model-comparison table and
 * the per-instance detail rows. Live runs poll + show running/queued rows. */
export function RunView({ run }: { run: IndexRun }) {
  const { data: card, isLoading, error } = useScorecard(run.scorecard, run.live);
  const labels = card?.meta?.labels ?? run.labels;
  const results = card?.results ?? [];
  const pending: PendingCase[] = card?.meta?.pending ?? [];

  // Tiers present in this run, first-seen order; fall back to declared tiers.
  const tierOrder: string[] = [];
  for (const r of results) {
    const t = r.tier ?? run.tiers[0] ?? "—";
    if (!tierOrder.includes(t)) tierOrder.push(t);
  }
  for (const p of pending) if (!tierOrder.includes(p.tier)) tierOrder.push(p.tier);
  const tiers = tierOrder.length ? tierOrder : run.tiers;

  const [active, setActive] = useState(0);
  const tier = tiers[Math.min(active, Math.max(0, tiers.length - 1))] ?? run.tiers[0] ?? "—";

  const tierResults = results.filter((r) => (r.tier ?? tiers[0]) === tier);
  const tierPending = pending.filter((p) => p.tier === tier);
  const models = summarizeModels(tierResults);

  const modelNames = [...new Set(results.map((r) => r.model))].map((m) => modelLabel(labels, m));
  const caseCount = countCases(results);
  const totalCases = caseCount + pending.length;

  return (
    <div>
      <header className="mb-6 border-b border-base-300 pb-5">
        <h1 className="text-2xl font-semibold text-base-content">
          Eval Scorecard
          {run.live && (
            <span className="ll-pulse ml-3 align-middle font-mono text-sm font-semibold text-accent">
              ● live{run.progress ? ` ${run.progress}` : ""}
            </span>
          )}
        </h1>
        <div className="mt-1.5 font-mono text-xs text-base-content/50">
          <b className="font-semibold text-base-content">{tiers.join(" + ")}</b> &nbsp;·&nbsp; models:{" "}
          <b className="font-semibold text-base-content">{modelNames.join(", ")}</b> &nbsp;·&nbsp;
          {caseCount}
          {pending.length ? ` / ${totalCases}` : ""} cases
          {run.runs > 1 && (
            <>
              {" "}
              &nbsp;·&nbsp; <b className="font-semibold text-base-content">{run.runs}×</b> per case{" "}
              <span className="text-base-content/40">(worst-case verdict · mean cost)</span>
            </>
          )}
          {run.gitSha && (
            <>
              {" "}
              &nbsp;·&nbsp; <span className="text-base-content/70">{run.gitSha}</span>
            </>
          )}
          &nbsp;·&nbsp; {fmtDate(card?.meta?.generatedAt ?? run.generatedAt)}
        </div>
      </header>

      {error && <ErrorNote message={(error as Error).message} />}
      {isLoading && !card ? (
        <Loading />
      ) : (
        <>
          {tiers.length > 1 && (
            <nav className="mb-4 flex flex-wrap gap-2">
              {tiers.map((t, i) => (
                <button
                  key={t}
                  onClick={() => setActive(i)}
                  className={
                    "rounded-lg border px-4 py-2 font-mono text-xs font-semibold " +
                    (t === tier
                      ? "border-accent bg-accent text-accent-content"
                      : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                  }
                >
                  {t}
                </button>
              ))}
            </nav>
          )}

          <h2 className="mb-3.5 mt-2 text-lg font-semibold text-base-content">
            Model comparison <span className="font-normal text-base-content/50">— {tier}</span>
          </h2>
          <CompareTable models={models} tier={tier} labels={labels} />

          <h2 className="mb-3.5 mt-8 text-lg font-semibold text-base-content">Per-instance results</h2>
          <InstanceTable tier={tier} results={tierResults} pending={tierPending} labels={labels} />
        </>
      )}
    </div>
  );
}

/** Distinct cases (instance × model), so trials don't inflate the count. */
function countCases(results: InstanceResult[]): number {
  return new Set(results.map((r) => `${r.tier ?? ""}|${r.model}|${r.instance_id}`)).size;
}

function Loading() {
  return <div className="py-16 text-center font-mono text-sm text-base-content/40">loading scorecard…</div>;
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-error/40 bg-error/10 px-4 py-3 font-mono text-xs text-error">
      {message}
    </div>
  );
}
