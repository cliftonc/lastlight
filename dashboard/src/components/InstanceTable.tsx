import type { InstanceResult, PendingCase } from "../types";
import { fmtMs, modelLabel } from "../lib/format";
import { Chip, Frac, Pill } from "./ui";

/** Per-instance result rows for one tier, plus running/queued rows for a live
 * run. Mirrors the old static report's detail table. */
export function InstanceTable({
  tier,
  results,
  pending,
  labels,
}: {
  tier: string;
  results: InstanceResult[];
  pending: PendingCase[];
  labels: Record<string, string>;
}) {
  const showCodeFix = tier === "code-fix";
  const cols = showCodeFix ? 7 : 6;
  // running before queued, so in-flight rows sit nearest the finished ones.
  const ordered = [...pending].sort((a, b) => (a.status === b.status ? 0 : a.status === "running" ? -1 : 1));

  return (
    <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-neutral text-2xs uppercase tracking-wide text-base-content/50">
            <th className="px-3 py-3 text-left font-semibold">instance</th>
            <th className="px-3 py-3 text-left font-semibold">model</th>
            {showCodeFix && <th className="px-3 py-3 text-left font-semibold">code-fix</th>}
            <th className="px-3 py-3 text-left font-semibold">behavioral</th>
            <th className="px-3 py-3 text-left font-semibold">checks</th>
            <th className="px-3 py-3 text-right font-semibold">cost</th>
            <th className="px-3 py-3 text-right font-semibold">latency</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const checks = r.behavioral?.checks ?? [];
            return (
              <tr key={`${r.instance_id}:${r.model}:${i}`} className="border-t border-base-300 align-middle">
                <td className="px-3 py-2.5 font-mono">{r.instance_id}</td>
                <td className="px-3 py-2.5 font-mono text-base-content/50">{modelLabel(labels, r.model)}</td>
                {showCodeFix && (
                  <td className="px-3 py-2.5">
                    {r.resolved === undefined ? (
                      <Pill kind="na">—</Pill>
                    ) : r.resolved ? (
                      <Pill kind="pass">resolved</Pill>
                    ) : (
                      <Pill kind="fail">unresolved</Pill>
                    )}
                    <Frac pass={r.resolvedPass} trials={r.trials} />
                  </td>
                )}
                <td className="px-3 py-2.5">
                  {r.error ? (
                    <Pill kind="fail">error</Pill>
                  ) : r.behavioral ? (
                    r.behavioral.ok ? (
                      <Pill kind="pass">ok</Pill>
                    ) : (
                      <Pill kind="fail">miss</Pill>
                    )
                  ) : (
                    <Pill kind="na">—</Pill>
                  )}
                  {!r.error && <Frac pass={r.behavioralPass} trials={r.trials} />}
                </td>
                <td className="px-3 py-2.5 leading-7">
                  {checks.length ? (
                    checks.map((c, j) => <Chip key={j} ok={c.ok} name={c.name} detail={c.detail} />)
                  ) : (
                    <span className="text-base-content/40">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">${r.costUsd.toFixed(4)}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">{fmtMs(r.durationMs)}</td>
              </tr>
            );
          })}
          {results.length === 0 && pending.length === 0 && (
            <tr>
              <td colSpan={cols} className="px-3 py-6 text-center font-mono text-base-content/40">
                no results yet
              </td>
            </tr>
          )}
          {ordered.map((pn, i) => (
            <tr key={`pending:${pn.instance_id}:${pn.model}:${i}`} className="border-t border-base-300 opacity-70">
              <td className="px-3 py-2.5 font-mono text-base-content/50">{pn.instance_id}</td>
              <td className="px-3 py-2.5 font-mono text-base-content/50">{modelLabel(labels, pn.model)}</td>
              {showCodeFix && (
                <td className="px-3 py-2.5">
                  {pn.status === "running" ? <Pill kind="run">running…</Pill> : <Pill kind="wait">queued</Pill>}
                </td>
              )}
              <td className="px-3 py-2.5">
                {!showCodeFix &&
                  (pn.status === "running" ? <Pill kind="run">running…</Pill> : <Pill kind="wait">queued</Pill>)}
                {showCodeFix && <span className="text-base-content/40">—</span>}
              </td>
              <td className="px-3 py-2.5 text-base-content/40">—</td>
              <td className="px-3 py-2.5 text-right font-mono text-base-content/40">—</td>
              <td className="px-3 py-2.5 text-right font-mono text-base-content/40">—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
