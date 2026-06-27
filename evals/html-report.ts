/**
 * Self-contained HTML scorecard, styled to match the Last Light site
 * (~/work/lastlight-www): dark navy theme, gold/orange/teal accents,
 * Inter + JetBrains Mono. No build step, no external assets beyond Google
 * Fonts — written straight to `evals/results/<tiers>/index.html`.
 *
 * One report, one tier per tab (radio-driven CSS, no JS). Each tab leads with
 * a model-comparison table — models as rows, sorted by the tier's primary
 * metric, with inline bar charts and best-in-column highlighting — followed by
 * the per-instance detail rows.
 */

import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { summarizeModels, type Scorecard, type ModelSummary } from "./report.js";
import type { InstanceResult } from "./schema.js";

export interface HtmlMeta {
  generatedAt: string;
  models: string[];
  tiers: string[];
  labels?: Record<string, string>;
  /** While the run is in flight: auto-refresh + a "live" badge. Off for the
   * final write so the published report is static. */
  live?: boolean;
  /** Optional progress text shown in the live badge (e.g. "7/30"). */
  progress?: string;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function pill(kind: "pass" | "fail" | "na", label: string): string {
  return `<span class="pill ${kind}">${esc(label)}</span>`;
}

function fmtMs(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

// ── tier metric model ─────────────────────────────────────────────────────────

interface TierMetric {
  /** Primary success metric for this tier (higher is better). */
  rate: (m: ModelSummary) => number;
  /** Fraction text e.g. "3/4" for the primary metric. */
  frac: (m: ModelSummary) => string;
  label: string;
}

function tierMetric(tier: string): TierMetric {
  if (tier === "code-fix") {
    return {
      label: "resolved",
      rate: (m) => (m.codeFixTotal ? m.codeFixResolved / m.codeFixTotal : 0),
      frac: (m) => (m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—"),
    };
  }
  return {
    label: "behavioral",
    rate: (m) => (m.behavioralTotal ? m.behavioralOk / m.behavioralTotal : 0),
    frac: (m) => (m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—"),
  };
}

/** A horizontal bar (0..1 fill) with a value label beside it. */
function bar(frac: number, value: string, klass: string, best: boolean): string {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  return `<div class="bar${best ? " best" : ""}"><span class="bar-track"><span class="bar-fill ${klass}" style="width:${pct.toFixed(1)}%"></span></span><span class="bar-val">${esc(value)}</span></div>`;
}

function compareTable(models: ModelSummary[], tier: string, labels: Record<string, string>): string {
  const metric = tierMetric(tier);
  const ranked = [...models].sort((a, b) => metric.rate(b) - metric.rate(a) || a.totalCostUsd - b.totalCostUsd);

  // Best-in-column references. Cost/latency only consider models that actually
  // produced a run (cost > 0) so an errored 0-cost row isn't crowned "cheapest".
  const bestRate = Math.max(0, ...ranked.map(metric.rate));
  const costs = ranked.filter((m) => m.totalCostUsd > 0).map((m) => m.totalCostUsd);
  const lats = ranked.filter((m) => m.p50DurationMs > 0).map((m) => m.p50DurationMs);
  const minCost = costs.length ? Math.min(...costs) : Infinity;
  const minLat = lats.length ? Math.min(...lats) : Infinity;
  const maxCost = costs.length ? Math.max(...costs) : 1;
  const maxLat = lats.length ? Math.max(...lats) : 1;

  const rows = ranked
    .map((m, i) => {
      const rate = metric.rate(m);
      const isBestRate = metric.frac(m) !== "—" && rate >= bestRate && bestRate > 0;
      const isBestCost = m.totalCostUsd > 0 && m.totalCostUsd === minCost;
      const isBestLat = m.p50DurationMs > 0 && m.p50DurationMs === minLat;
      return `
      <tr>
        <td class="rank">${i + 1}</td>
        <td class="mono model">${esc(labels[m.model] ?? m.model)}</td>
        <td class="barcell">${bar(rate, metric.frac(m), "fill-gold", isBestRate)}</td>
        <td class="barcell">${bar(maxCost ? m.totalCostUsd / maxCost : 0, `$${m.totalCostUsd.toFixed(3)}`, "fill-teal", isBestCost)}</td>
        <td class="barcell">${bar(maxLat ? m.p50DurationMs / maxLat : 0, fmtMs(m.p50DurationMs), "fill-orange", isBestLat)}</td>
        <td class="mono num">${Math.round(m.avgInputTokens)}<span class="muted">/</span>${Math.round(m.avgOutputTokens)}</td>
        <td class="mono num ${m.errors ? "fail-fg" : "muted"}">${m.errors}</td>
      </tr>`;
    })
    .join("\n");

  return `
    <table class="cmp">
      <thead>
        <tr>
          <th class="rank">#</th><th>model</th>
          <th>${esc(metric.label)} →</th><th>total cost ↓</th><th>p50 latency ↓</th>
          <th class="num">avg in/out tok</th><th class="num">err</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function checksHtml(r: InstanceResult): string {
  const checks = r.behavioral?.checks ?? [];
  if (!checks.length && r.resolved === undefined) return '<span class="muted">—</span>';
  const chips = checks
    .map((c) => `<span class="chip ${c.ok ? "ok" : "no"}" title="${esc(c.detail ?? "")}">${esc(c.name)}</span>`)
    .join("");
  return chips || '<span class="muted">—</span>';
}

function detailRows(results: InstanceResult[], tier: string, labels: Record<string, string>): string {
  const showCodeFix = tier === "code-fix";
  return results
    .map((r) => {
      const resolved =
        r.resolved === undefined ? pill("na", "—") : r.resolved ? pill("pass", "resolved") : pill("fail", "unresolved");
      const beh = r.error
        ? pill("fail", "error")
        : r.behavioral
          ? r.behavioral.ok
            ? pill("pass", "ok")
            : pill("fail", "miss")
          : pill("na", "—");
      return `
      <tr>
        <td class="mono">${esc(r.instance_id)}</td>
        <td class="mono muted">${esc(labels[r.model] ?? r.model)}</td>
        ${showCodeFix ? `<td>${resolved}</td>` : ""}
        <td>${beh}</td>
        <td class="checks">${checksHtml(r)}</td>
        <td class="mono num">$${r.costUsd.toFixed(4)}</td>
        <td class="mono num">${fmtMs(r.durationMs)}</td>
      </tr>${r.error ? `<tr class="errrow"><td colspan="${showCodeFix ? 7 : 6}" class="mono err">${esc(r.error)}</td></tr>` : ""}`;
    })
    .join("\n");
}

function tierPane(tier: string, results: InstanceResult[], labels: Record<string, string>): string {
  const models = summarizeModels(results);
  const showCodeFix = tier === "code-fix";
  const detailHead = showCodeFix
    ? "<th>instance</th><th>model</th><th>code-fix</th><th>behavioral</th><th>checks</th><th>cost</th><th>latency</th>"
    : "<th>instance</th><th>model</th><th>behavioral</th><th>checks</th><th>cost</th><th>latency</th>";
  return `
      <h2>Model comparison <span class="muted">— ${esc(tier)}</span></h2>
      ${compareTable(models, tier, labels)}
      <h2>Per-instance results</h2>
      <table>
        <thead><tr>${detailHead}</tr></thead>
        <tbody>${detailRows(results, tier, labels)}</tbody>
      </table>`;
}

export function renderHtml(card: Scorecard, meta: HtmlMeta): string {
  const labels = meta.labels ?? {};
  // Preserve the requested tier order, but only keep tiers that produced results.
  const tiers = meta.tiers.filter((t) => card.results.some((r) => (r.tier ?? meta.tiers[0]) === t));
  const useTiers = tiers.length ? tiers : meta.tiers.slice(0, 1);

  const radios = useTiers.map((_, i) => `<input type="radio" name="tier" id="t${i}"${i === 0 ? " checked" : ""}>`).join("\n  ");
  const tabs = useTiers.map((t, i) => `<label for="t${i}">${esc(t)}</label>`).join("\n      ");
  const panes = useTiers
    .map((t, i) => {
      const rs = card.results.filter((r) => (r.tier ?? useTiers[0]) === t);
      return `<section class="pane pane-${i}">${tierPane(t, rs, labels)}</section>`;
    })
    .join("\n    ");

  // Per-index CSS so the checked radio reveals its pane + lights its tab.
  const tabCss = useTiers
    .map(
      (_, i) =>
        `#t${i}:checked ~ .pane-${i}{display:block;} #t${i}:checked ~ .tabs label[for=t${i}]{background:var(--gold);color:var(--navy);border-color:var(--gold);}`,
    )
    .join("\n  ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${meta.live ? '<meta http-equiv="refresh" content="3" />' : ""}
<title>Last Light — Eval Scorecard</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --gold:#F0B429; --orange:#E8752A; --teal:#1A7A8A; --teal-dark:#135E6B;
    --navy:#1B2735; --bg:#0C1117; --bg-card:#141B24; --bg-card-hover:#1A2332;
    --border:#1E2A38; --text:#C9D1D9; --text-muted:#7D8694; --text-bright:#ECEFF4;
    --pass:#3FB950; --fail:#E5534B;
    --mono:'JetBrains Mono',monospace; --sans:'Inter',-apple-system,sans-serif;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.55; }
  .wrap { max-width:1100px; margin:0 auto; padding:48px 24px 80px; }
  header { border-bottom:1px solid var(--border); padding-bottom:24px; margin-bottom:24px; }
  h1 { color:var(--text-bright); font-size:30px; margin:0 0 6px; letter-spacing:-0.02em; }
  h1 .accent { color:var(--gold); }
  h2 { color:var(--text-bright); font-size:18px; margin:32px 0 14px; }
  h2 .muted { font-weight:400; }
  .meta { color:var(--text-muted); font-size:13px; font-family:var(--mono); }
  .meta b { color:var(--text); font-weight:600; }

  /* radio-driven tabs (no JS) */
  input[name=tier] { position:absolute; opacity:0; pointer-events:none; }
  .tabs { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
  .tabs label { cursor:pointer; font-family:var(--mono); font-size:13px; font-weight:600;
    padding:8px 16px; border-radius:8px; border:1px solid var(--border); color:var(--text-muted);
    background:var(--bg-card); user-select:none; }
  .tabs label:hover { color:var(--text-bright); border-color:var(--teal); }
  .pane { display:none; }
  ${tabCss}

  table { width:100%; border-collapse:collapse; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  th { text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; padding:11px 14px; border-bottom:1px solid var(--border); background:var(--navy); }
  td { padding:10px 14px; border-bottom:1px solid var(--border); font-size:13px; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:var(--mono); }
  .num { text-align:right; white-space:nowrap; }
  .muted { color:var(--text-muted); }
  .fail-fg { color:var(--fail); }

  /* comparison table */
  table.cmp td { vertical-align:middle; }
  .cmp .rank { width:30px; color:var(--text-muted); font-family:var(--mono); text-align:center; }
  .cmp .model { color:var(--gold); font-weight:600; white-space:nowrap; }
  .cmp .barcell { width:22%; min-width:140px; }
  .bar { display:flex; align-items:center; gap:8px; }
  .bar-track { flex:1; height:8px; background:var(--navy); border-radius:999px; overflow:hidden; }
  .bar-fill { display:block; height:100%; border-radius:999px; }
  .fill-gold { background:var(--gold); } .fill-teal { background:var(--teal); } .fill-orange { background:var(--orange); }
  .bar-val { font-family:var(--mono); font-size:12px; min-width:48px; text-align:right; color:var(--text); }
  .bar.best .bar-val { color:var(--pass); font-weight:600; }
  .bar.best .bar-val::after { content:" ★"; color:var(--gold); font-size:10px; }

  .pill { display:inline-block; font-family:var(--mono); font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; }
  .pill.pass { background:rgba(63,185,80,0.14); color:var(--pass); }
  .pill.fail { background:rgba(229,83,75,0.14); color:var(--fail); }
  .pill.na { background:var(--navy); color:var(--text-muted); }
  .checks { line-height:2; }
  .chip { display:inline-block; font-family:var(--mono); font-size:10.5px; padding:2px 7px; border-radius:5px; margin:0 4px 4px 0; border:1px solid var(--border); }
  .chip.ok { color:var(--pass); border-color:rgba(63,185,80,0.4); }
  .chip.no { color:var(--fail); border-color:rgba(229,83,75,0.4); }
  .errrow td { color:var(--fail); background:rgba(229,83,75,0.06); }
  .err { white-space:pre-wrap; }
  footer { margin-top:40px; color:var(--text-muted); font-size:12px; font-family:var(--mono); }
  a { color:var(--gold); }
  .live { font-family:var(--mono); font-size:13px; color:var(--gold); font-weight:600; letter-spacing:0; vertical-align:middle; margin-left:10px; animation:pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.35;} }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Last Light <span class="accent">·</span> Eval Scorecard${
        meta.live ? ` <span class="live">● live${meta.progress ? ` ${esc(meta.progress)}` : ""}</span>` : ""
      }</h1>
      <div class="meta">
        <b>${esc(useTiers.join(" + "))}</b> &nbsp;·&nbsp;
        models: <b>${esc(meta.models.join(", "))}</b> &nbsp;·&nbsp;
        ${esc(card.results.length)} runs &nbsp;·&nbsp;
        ${esc(meta.generatedAt)}
      </div>
    </header>

    <div class="tabwrap">
      ${radios}
      <nav class="tabs">
      ${tabs}
      </nav>
    ${panes}
    </div>

    <footer>
      Real production workflows · mocked GitHub · deterministic grading. ★ = best in column.
      Generated by <span class="mono">npm run eval</span>. Also: scorecard.json · predictions.jsonl.
    </footer>
  </div>
  <script>
    // Preserve the active tab + scroll position across the live auto-refresh.
    (function () {
      try {
        var K = "ll-eval-tab", S = "ll-eval-scroll";
        var saved = sessionStorage.getItem(K);
        if (saved) { var r = document.getElementById(saved); if (r) r.checked = true; }
        document.querySelectorAll('input[name=tier]').forEach(function (radio) {
          radio.addEventListener("change", function () { sessionStorage.setItem(K, radio.id); });
        });
        var y = sessionStorage.getItem(S);
        if (y) window.scrollTo(0, parseInt(y, 10) || 0);
        window.addEventListener("scroll", function () { sessionStorage.setItem(S, String(window.scrollY)); }, { passive: true });
      } catch (e) {}
    })();
  </script>
</body>
</html>
`;
}

export function writeHtml(dir: string, card: Scorecard, meta: HtmlMeta): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  // Write-then-rename so a browser auto-refreshing during a live run never
  // reads a half-written file (rename is atomic on the same filesystem).
  const tmp = join(dir, ".index.html.tmp");
  writeFileSync(tmp, renderHtml(card, meta));
  renameSync(tmp, file);
  return file;
}
