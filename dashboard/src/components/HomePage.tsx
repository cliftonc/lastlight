import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { api, type WorkflowRun } from "../api";
import { useStatsSeries } from "../hooks/useDailyStats";
import clsx from "clsx";

type StatRange = "today" | "7d" | "30d";

// Recharts can't resolve `hsl(var(--p))` because it parses fill strings
// internally for tooltip swatches and gradients. Use literal hex matching
// the daisyUI `lastlight` theme so the chart renders.
const CHART = {
  success: "#86efac",
  error: "#fca5a5",
  primary: "#7dd3fc",
  secondary: "#c4b5fd",
  accent: "#fcd34d",
  info: "#67e8f9",
  grid: "#21262d",
  axis: "rgba(230, 237, 243, 0.45)",
  tooltipBg: "#161b22",
  tooltipBorder: "#21262d",
};

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function StatusBadge({ status }: { status: WorkflowRun["status"] }) {
  const cls = clsx("badge badge-xs font-mono", {
    "badge-info": status === "running",
    "badge-warning": status === "paused",
    "badge-success": status === "succeeded",
    "badge-error": status === "failed",
    "badge-ghost": status === "cancelled",
  });
  return <span className={cls}>{status}</span>;
}

function useLiveActivity() {
  const [workflowCount, setWorkflowCount] = useState(0);
  const [liveWorkflows, setLiveWorkflows] = useState<WorkflowRun[]>([]);
  const [containerCount, setContainerCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [wf, ct] = await Promise.all([
          api.workflowRuns({ status: "active", limit: 5 }),
          api.containers(),
        ]);
        if (!cancelled) {
          setWorkflowCount(wf.total);
          setLiveWorkflows(wf.workflowRuns);
          setContainerCount(ct.containers.length);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return { workflowCount, liveWorkflows, containerCount };
}

function useRecentWorkflows() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.workflowRuns({ limit: 3 });
        if (!cancelled) setRuns(res.workflowRuns);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return runs;
}

function LiveActivitySection({
  workflowCount,
  liveWorkflows,
  containerCount,
}: {
  workflowCount: number;
  liveWorkflows: WorkflowRun[];
  containerCount: number;
}) {
  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide mb-3">
          Live Activity
        </h2>
        <div className="flex gap-4 mb-4">
          <div className="stat bg-base-100 rounded-box p-3 flex-1">
            <div className="stat-title text-xs">Active Workflows</div>
            <div className="stat-value text-2xl text-primary">{workflowCount}</div>
          </div>
          <div className="stat bg-base-100 rounded-box p-3 flex-1">
            <div className="stat-title text-xs">Running Containers</div>
            <div className="stat-value text-2xl text-secondary">{containerCount}</div>
          </div>
        </div>
        {liveWorkflows.length === 0 ? (
          <p className="text-xs text-base-content/40 text-center py-4">No active workflows</p>
        ) : (
          <div className="space-y-1">
            {liveWorkflows.map((run) => (
              <div
                key={run.id}
                className="flex items-center gap-2 px-3 py-2 bg-base-100 rounded text-xs"
              >
                <StatusBadge status={run.status} />
                <span className="font-mono text-base-content/70 truncate flex-1">
                  {run.repo ? `${run.repo}` : run.workflowName}
                  {run.issueNumber ? `#${run.issueNumber}` : ""}
                </span>
                <span className="text-base-content/50 shrink-0">{run.currentPhase}</span>
                <span className="text-base-content/40 shrink-0">{timeAgo(run.startedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecentWorkflowsSection({
  runs,
  onSelect,
}: {
  runs: WorkflowRun[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide mb-3">
          Recent Workflows
        </h2>
        {runs.length === 0 ? (
          <p className="text-xs text-base-content/40 text-center py-4">No workflows yet</p>
        ) : (
          <div className="space-y-1">
            {runs.map((run) => {
              const durationMs = run.finishedAt
                ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
                : null;
              const duration = durationMs
                ? durationMs < 60000
                  ? `${Math.round(durationMs / 1000)}s`
                  : `${Math.floor(durationMs / 60000)}m${Math.round((durationMs % 60000) / 1000)}s`
                : null;
              return (
                <button
                  key={run.id}
                  onClick={() => onSelect(run.id)}
                  className="flex items-center gap-2 px-3 py-2 bg-base-100 rounded text-xs w-full text-left hover:bg-base-300/60 transition-colors"
                >
                  <StatusBadge status={run.status} />
                  <span className="font-mono text-base-content/90 shrink-0">
                    {run.workflowName}
                  </span>
                  {(run.repo || run.issueNumber) && (
                    <span className="font-mono text-base-content/50 truncate flex-1">
                      {run.repo ?? ""}
                      {run.issueNumber ? `#${run.issueNumber}` : ""}
                    </span>
                  )}
                  {!run.repo && !run.issueNumber && <span className="flex-1" />}
                  {duration && (
                    <span className="text-base-content/50 shrink-0">{duration}</span>
                  )}
                  <span className="text-base-content/40 shrink-0">{timeAgo(run.startedAt)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatsChartsSection() {
  const [range, setRange] = useState<StatRange>("7d");
  const granularity = range === "today" ? "hour" : "day";
  const count = range === "today" ? 24 : range === "7d" ? 7 : 30;
  const { series, loading } = useStatsSeries(granularity, count);

  const summary = series
    ? series.reduce(
        (acc, d) => ({
          executions: acc.executions + d.executions,
          tokens: acc.tokens + d.totalTokens,
          cost: acc.cost + d.costUsd,
        }),
        { executions: 0, tokens: 0, cost: 0 },
      )
    : null;

  const chartData = series?.map((d) => ({
    // Hourly bucket key is `YYYY-MM-DDTHH` → render `HH:00`.
    // Daily bucket key is `YYYY-MM-DD` → render `MM-DD`.
    date: granularity === "hour" ? `${d.date.slice(11, 13)}:00` : d.date.slice(5),
    executions: d.executions,
    successes: d.successes,
    failures: d.failures,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheTokens: d.cacheReadTokens,
    cost: d.costUsd,
  })) ?? [];

  const hasData = chartData.some((d) => d.executions > 0);

  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide">
            Stats
          </h2>
          <div className="join">
            {(["today", "7d", "30d"] as StatRange[]).map((r) => (
              <button
                key={r}
                className={`join-item btn btn-xs ${range === r ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Summary stat cards */}
        {summary && (
          <div className="flex gap-3 mb-4">
            <div className="stat bg-base-100 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Executions</div>
              <div className="stat-value text-xl">{summary.executions}</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Tokens</div>
              <div className="stat-value text-xl">{formatTokens(summary.tokens)}</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Cost</div>
              <div className="stat-value text-xl">{formatCost(summary.cost)}</div>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-32 text-base-content/40 text-xs">
            Loading…
          </div>
        )}

        {!loading && !hasData && (
          <div className="flex items-center justify-center h-32 text-base-content/40 text-xs">
            No data yet
          </div>
        )}

        {!loading && hasData && (
          <div className="space-y-4">
            {/* Execution count bar chart */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Executions per {granularity}</p>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={chartData} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                  />
                  <Line type="monotone" dataKey="successes" stroke={CHART.success} strokeWidth={2} dot={false} name="success" />
                  <Line type="monotone" dataKey="failures" stroke={CHART.error} strokeWidth={2} dot={false} name="failure" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Token usage stacked area */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Token usage per {granularity}</p>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={chartData} margin={{ top: 2, right: -10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis
                    yAxisId="io"
                    tick={{ fontSize: 10, fill: CHART.axis }}
                    stroke={CHART.axis}
                    tickFormatter={formatTokens}
                  />
                  <YAxis
                    yAxisId="cache"
                    orientation="right"
                    tick={{ fontSize: 10, fill: CHART.axis }}
                    stroke={CHART.axis}
                    tickFormatter={formatTokens}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                    formatter={(v: number) => formatTokens(v)}
                  />
                  <Line yAxisId="io" type="monotone" dataKey="inputTokens" stroke={CHART.primary} strokeWidth={2} dot={false} name="input" />
                  <Line yAxisId="io" type="monotone" dataKey="outputTokens" stroke={CHART.secondary} strokeWidth={2} dot={false} name="output" />
                  <Line yAxisId="cache" type="monotone" dataKey="cacheTokens" stroke={CHART.accent} strokeWidth={2} strokeDasharray="4 2" dot={false} name="cache" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Cost area chart */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Cost per {granularity} (USD)</p>
              <ResponsiveContainer width="100%" height={100}>
                <LineChart data={chartData} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                    formatter={(v: number) => formatCost(v)}
                  />
                  <Line type="monotone" dataKey="cost" stroke={CHART.info} strokeWidth={2} dot={false} name="cost" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function HomePage({ onSelectWorkflow }: { onSelectWorkflow: (id: string) => void }) {
  const { workflowCount, liveWorkflows, containerCount } = useLiveActivity();
  const recentRuns = useRecentWorkflows();

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <LiveActivitySection
            workflowCount={workflowCount}
            liveWorkflows={liveWorkflows}
            containerCount={containerCount}
          />
          <RecentWorkflowsSection runs={recentRuns} onSelect={onSelectWorkflow} />
        </div>
        <div className="lg:col-span-3">
          <StatsChartsSection />
        </div>
      </div>
    </div>
  );
}
