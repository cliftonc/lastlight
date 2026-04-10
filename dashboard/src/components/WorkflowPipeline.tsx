import clsx from "clsx";
import type { WorkflowRun, PhaseHistoryEntry } from "../api";

const CANONICAL_PHASES = ["guardrails", "architect", "executor", "reviewer", "pr", "complete"];

const PHASE_LABELS: Record<string, string> = {
  guardrails: "Guardrails",
  architect: "Architect",
  executor: "Executor",
  reviewer: "Reviewer",
  pr: "PR",
  complete: "Complete",
};

type PhaseStatus = "pending" | "active" | "paused" | "done" | "failed";

interface PhaseNode {
  name: string;
  label: string;
  status: PhaseStatus;
  timestamp?: string;
  duration?: number;
}

function derivePhases(run: WorkflowRun): PhaseNode[] {
  const historyMap = new Map<string, PhaseHistoryEntry>();
  for (const entry of run.phaseHistory) {
    historyMap.set(entry.phase, entry);
  }

  // Build phase list: canonical phases + any extra phases from history not in canonical
  const extraPhases = run.phaseHistory
    .map((e) => e.phase)
    .filter((p) => p !== "phase_0" && !CANONICAL_PHASES.includes(p));
  const uniqueExtra = Array.from(new Set(extraPhases));
  const allPhases = [...CANONICAL_PHASES, ...uniqueExtra];

  return allPhases.map((name) => {
    const label = PHASE_LABELS[name] ?? name;
    const histEntry = historyMap.get(name);

    if (histEntry) {
      const status: PhaseStatus = histEntry.success ? "done" : "failed";
      // Compute duration to next phase if possible
      const idx = run.phaseHistory.findIndex((e) => e.phase === name);
      let duration: number | undefined;
      if (idx >= 0 && idx + 1 < run.phaseHistory.length) {
        const next = run.phaseHistory[idx + 1];
        if (next) {
          duration =
            (new Date(next.timestamp).getTime() - new Date(histEntry.timestamp).getTime()) / 1000;
        }
      } else if (histEntry && run.finishedAt) {
        duration =
          (new Date(run.finishedAt).getTime() - new Date(histEntry.timestamp).getTime()) / 1000;
      }
      return { name, label, status, timestamp: histEntry.timestamp, duration };
    }

    if (name === run.currentPhase) {
      const status: PhaseStatus = run.status === "paused" ? "paused" : "active";
      return { name, label, status };
    }

    return { name, label, status: "pending" };
  });
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m${s}s`;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function PhaseNodeBadge({ node }: { node: PhaseNode }) {
  const dotClass = clsx("w-3 h-3 rounded-full shrink-0", {
    "bg-success": node.status === "done",
    "bg-error": node.status === "failed",
    "bg-info animate-pulse": node.status === "active",
    "bg-warning": node.status === "paused",
    "bg-base-300": node.status === "pending",
  });

  const containerClass = clsx(
    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg border min-w-[80px]",
    {
      "border-success/40 bg-success/5": node.status === "done",
      "border-error/40 bg-error/5": node.status === "failed",
      "border-info/40 bg-info/5": node.status === "active",
      "border-warning/40 bg-warning/5": node.status === "paused",
      "border-base-300/40 bg-base-200/30": node.status === "pending",
    },
  );

  return (
    <div className={containerClass}>
      <div className="flex items-center gap-1.5">
        <span className={dotClass} />
        <span className="text-xs font-medium text-base-content/80">{node.label}</span>
      </div>
      {node.timestamp && (
        <span className="text-2xs text-base-content/40 font-mono">{formatTime(node.timestamp)}</span>
      )}
      {node.duration !== undefined && (
        <span className="text-2xs text-base-content/40 font-mono">{formatDuration(node.duration)}</span>
      )}
    </div>
  );
}

interface Props {
  run: WorkflowRun;
}

export function WorkflowPipeline({ run }: Props) {
  const phases = derivePhases(run);

  return (
    <div className="flex items-center gap-0 flex-wrap">
      {phases.map((node, idx) => (
        <div key={node.name} className="flex items-center">
          <PhaseNodeBadge node={node} />
          {idx < phases.length - 1 && (
            <div className="w-6 h-px bg-base-300/60 shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
}
