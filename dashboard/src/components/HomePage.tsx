import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { api, type WorkflowRun } from "../api";
import { useDailyStats } from "../hooks/useDailyStats";
import clsx from "clsx";

type StatRange = "today" | "7d" | "30d";

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

function RecentWorkflowsSection({ runs }: { runs: WorkflowRun[] }) {
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
                <div
                  key={run.id}
                  className="flex items-center gap-2 px-3 py-2 bg-base-100 rounded text-xs"
                >
                  <StatusBadge status={run.status} />
                  <span className="font-mono text-base-content/70 truncate flex-1">
                    {run.repo ? `${run.repo}` : run.workflowName}
                    {run.issueNumber ? `#${run.issueNumber}` : ""}
                  </span>
                  {duration && (
                    <span className="text-base-content/50 shrink-0">{duration}</span>
                  )}
                  <span className="text-base-content/40 shrink-0">{timeAgo(run.startedAt)}</span>
                </div>
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
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const { daily, loading } = useDailyStats(days);

  const summary = daily
    ? daily.reduce(
        (acc, d) => ({
          executions: acc.executions + d.executions,
          tokens: acc.tokens + d.totalTokens,
          cost: acc.cost + d.costUsd,
        }),
        { executions: 0, tokens: 0, cost: 0 },
      )
    : null;

  const chartData = daily?.map((d) => ({
    date: d.date.slice(5), // MM-DD
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
              <p className="text-xs text-base-content/50 mb-1 font-medium">Executions per day</p>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--b3))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--bc) / 0.3)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--bc) / 0.3)" allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--b2))", border: "1px solid hsl(var(--b3))" }}
                  />
                  <Bar dataKey="successes" stackId="a" fill="hsl(var(--su))" name="success" />
                  <Bar dataKey="failures" stackId="a" fill="hsl(var(--er))" name="failure" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Token usage stacked area */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Token usage per day</p>
              <ResponsiveContainer width="100%" height={120}>
                <AreaChart data={chartData} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--b3))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--bc) / 0.3)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--bc) / 0.3)" tickFormatter={formatTokens} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--b2))", border: "1px solid hsl(var(--b3))" }}
                    formatter={(v: number) => formatTokens(v)}
                  />
                  <Area type="monotone" dataKey="inputTokens" stackId="t" fill="hsl(var(--p) / 0.4)" stroke="hsl(var(--p))" name="input" />
                  <Area type="monotone" dataKey="outputTokens" stackId="t" fill="hsl(var(--s) / 0.4)" stroke="hsl(var(--s))" name="output" />
                  <Area type="monotone" dataKey="cacheTokens" stackId="t" fill="hsl(var(--a) / 0.4)" stroke="hsl(var(--a))" name="cache" />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Cost area chart */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Cost per day (USD)</p>
              <ResponsiveContainer width="100%" height={100}>
                <AreaChart data={chartData} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--b3))" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--bc) / 0.3)" />
                  <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--bc) / 0.3)" tickFormatter={(v) => `$${v.toFixed(2)}`} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--b2))", border: "1px solid hsl(var(--b3))" }}
                    formatter={(v: number) => formatCost(v)}
                  />
                  <Area type="monotone" dataKey="cost" fill="hsl(var(--in) / 0.3)" stroke="hsl(var(--in))" name="cost" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function HomePage() {
  const { workflowCount, liveWorkflows, containerCount } = useLiveActivity();
  const recentRuns = useRecentWorkflows();

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LiveActivitySection
          workflowCount={workflowCount}
          liveWorkflows={liveWorkflows}
          containerCount={containerCount}
        />
        <RecentWorkflowsSection runs={recentRuns} />
      </div>
      <StatsChartsSection />
    </div>
  );
}
