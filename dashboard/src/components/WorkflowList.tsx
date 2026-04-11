import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { api, type WorkflowRun, type WorkflowApproval } from "../api";
import { WorkflowPipeline } from "./WorkflowPipeline";
import { ApprovalBanner } from "./ApprovalBanner";

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function elapsed(run: WorkflowRun): string {
  const end = run.finishedAt ?? run.updatedAt;
  const secs = Math.floor((new Date(end).getTime() - new Date(run.startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
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

interface DetailPanelProps {
  run: WorkflowRun;
  approvals: WorkflowApproval[];
  onCancel: (id: string) => void;
  onApprovalResponded: () => void;
}

function DetailPanel({ run, approvals, onCancel, onApprovalResponded }: DetailPanelProps) {
  const runApprovals = approvals.filter((a) => a.workflowRunId === run.id);
  const canCancel = run.status === "running" || run.status === "paused";

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-base-content">{run.workflowName}</span>
        <StatusBadge status={run.status} />
        {run.repo && (
          <span className="text-xs text-base-content/50 font-mono">{run.repo}</span>
        )}
        {run.issueNumber && (
          <span className="text-xs text-base-content/50 font-mono">#{run.issueNumber}</span>
        )}
        {canCancel && (
          <button
            className="btn btn-xs btn-error btn-outline ml-auto"
            onClick={() => onCancel(run.id)}
          >
            Cancel
          </button>
        )}
      </div>

      <div className="text-2xs text-base-content/40 font-mono flex gap-4">
        <span>started {timeAgo(run.startedAt)} ago</span>
        <span>elapsed {elapsed(run)}</span>
        {run.finishedAt && <span>finished {timeAgo(run.finishedAt)} ago</span>}
      </div>

      <ApprovalBanner approvals={runApprovals} onResponded={onApprovalResponded} />

      <div>
        <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
          Pipeline
        </div>
        <div className="overflow-x-auto">
          <WorkflowPipeline run={run} />
        </div>
      </div>

      {run.phaseHistory.length > 0 && (
        <div>
          <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
            Phase History
          </div>
          <ul className="flex flex-col gap-1">
            {run.phaseHistory.map((entry, i) => (
              <li key={i} className="flex items-center gap-2 text-xs">
                <span
                  className={clsx("w-2 h-2 rounded-full shrink-0", {
                    "bg-success": entry.success,
                    "bg-error": !entry.success,
                  })}
                />
                <span className="font-mono text-base-content/70 w-24 shrink-0">{entry.phase}</span>
                <span className="text-base-content/40 font-mono text-2xs">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                {entry.summary && (
                  <span className="text-base-content/60 truncate">{entry.summary}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WorkflowList() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [approvals, setApprovals] = useState<WorkflowApproval[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [runsData, approvalsData] = await Promise.all([
        api.workflowRuns({ limit: 20 }),
        api.approvals().catch(() => ({ approvals: [] as WorkflowApproval[] })),
      ]);
      setRuns(runsData.workflowRuns);
      setApprovals(approvalsData.approvals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  // Auto-select first run
  useEffect(() => {
    if (!selectedId && runs.length > 0) {
      setSelectedId(runs[0]!.id);
    }
  }, [runs, selectedId]);

  const handleCancel = async (id: string) => {
    try {
      await api.cancelWorkflowRun(id);
      await load();
    } catch { /* ignore */ }
  };

  const selectedRun = runs.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* List panel */}
      <aside className="w-80 shrink-0 border-r border-base-300 bg-base-200/40 overflow-y-auto flex flex-col">
        {error && (
          <div className="px-3 py-2 text-2xs text-error border-b border-base-300">{error}</div>
        )}
        <ul className="flex-1">
          {runs.map((run) => {
            const active = run.id === selectedId;
            const canCancel = run.status === "running" || run.status === "paused";
            const hasApprovals = approvals.some((a) => a.workflowRunId === run.id);
            return (
              <li key={run.id} className="border-b border-base-300/40">
                <button
                  onClick={() => setSelectedId(run.id)}
                  className={clsx(
                    "w-full flex flex-col items-start gap-0.5 py-2 px-3 text-left transition-colors",
                    active
                      ? "bg-primary/15 border-l-2 border-l-primary -ml-px pl-[10px]"
                      : "hover:bg-base-300/40 border-l-2 border-l-transparent -ml-px pl-[10px]",
                  )}
                >
                  <div className="flex items-center gap-2 w-full text-2xs">
                    <StatusBadge status={run.status} />
                    {hasApprovals && (
                      <span className="badge badge-warning badge-xs">approval</span>
                    )}
                    <span className="ml-auto text-base-content/40 font-mono">
                      {timeAgo(run.startedAt)} ago
                    </span>
                  </div>
                  <div className="text-sm truncate w-full text-base-content/90">
                    {run.workflowName}
                  </div>
                  <div className="flex gap-2 text-2xs text-base-content/40 w-full font-mono">
                    {run.repo && <span className="truncate">{run.repo}</span>}
                    {run.issueNumber && <span>#{run.issueNumber}</span>}
                    <span className="ml-auto">{run.currentPhase}</span>
                  </div>
                  {canCancel && (
                    <button
                      className="btn btn-2xs btn-error btn-outline mt-1 h-5 min-h-0 text-2xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancel(run.id);
                      }}
                    >
                      cancel
                    </button>
                  )}
                </button>
              </li>
            );
          })}
          {runs.length === 0 && !error && (
            <li className="p-6 text-center text-base-content/40 text-xs">no workflow runs</li>
          )}
        </ul>
      </aside>

      {/* Detail panel */}
      {selectedRun ? (
        <DetailPanel
          run={selectedRun}
          approvals={approvals}
          onCancel={handleCancel}
          onApprovalResponded={load}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
          select a workflow run
        </div>
      )}
    </div>
  );
}
