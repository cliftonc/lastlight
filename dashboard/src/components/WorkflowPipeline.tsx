import { useMemo } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  Position,
  Handle,
  type NodeProps,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
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

interface PhaseNodeData extends Record<string, unknown> {
  label: string;
  status: PhaseStatus;
  timestamp?: string;
  duration?: number;
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

function PhaseFlowNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  const dotClass = clsx("w-2.5 h-2.5 rounded-full shrink-0", {
    "bg-success": data.status === "done",
    "bg-error": data.status === "failed",
    "bg-info animate-pulse": data.status === "active",
    "bg-warning": data.status === "paused",
    "bg-base-300": data.status === "pending",
  });

  const containerClass = clsx(
    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg border min-w-[80px] text-center",
    {
      "border-success/40 bg-success/5": data.status === "done",
      "border-error/40 bg-error/5": data.status === "failed",
      "border-info/40 bg-info/5": data.status === "active",
      "border-warning/40 bg-warning/5": data.status === "paused",
      "border-base-300/40 bg-base-200/30": data.status === "pending",
    },
  );

  return (
    <div className={containerClass}>
      <Handle type="target" position={Position.Left} className="!bg-base-300/60 !border-none !w-1 !h-1" />
      <div className="flex items-center gap-1.5">
        <span className={dotClass} />
        <span className="text-xs font-medium text-base-content/80">{data.label}</span>
      </div>
      {data.timestamp && (
        <span className="text-2xs text-base-content/40 font-mono">{formatTime(data.timestamp)}</span>
      )}
      {data.duration !== undefined && (
        <span className="text-2xs text-base-content/40 font-mono">{formatDuration(data.duration)}</span>
      )}
      <Handle type="source" position={Position.Right} className="!bg-base-300/60 !border-none !w-1 !h-1" />
    </div>
  );
}

const nodeTypes = { phase: PhaseFlowNode };

const NODE_WIDTH = 110;
const NODE_HEIGHT = 70;
const NODE_GAP = 40;

interface Props {
  run: WorkflowRun;
}

export function WorkflowPipeline({ run }: Props) {
  const { nodes, edges } = useMemo(() => {
    const historyMap = new Map<string, PhaseHistoryEntry>();
    for (const entry of run.phaseHistory) {
      historyMap.set(entry.phase, entry);
    }

    const extraPhases = run.phaseHistory
      .map((e) => e.phase)
      .filter((p) => p !== "phase_0" && !CANONICAL_PHASES.includes(p));
    const uniqueExtra = Array.from(new Set(extraPhases));
    const allPhases = [...CANONICAL_PHASES, ...uniqueExtra];

    const nodes: Node<PhaseNodeData>[] = allPhases.map((name, idx) => {
      const label = PHASE_LABELS[name] ?? name;
      const histEntry = historyMap.get(name);

      let status: PhaseStatus = "pending";
      let timestamp: string | undefined;
      let duration: number | undefined;

      if (histEntry) {
        status = histEntry.success ? "done" : "failed";
        timestamp = histEntry.timestamp;
        const i = run.phaseHistory.findIndex((e) => e.phase === name);
        if (i >= 0 && i + 1 < run.phaseHistory.length) {
          const next = run.phaseHistory[i + 1];
          if (next) {
            duration =
              (new Date(next.timestamp).getTime() - new Date(histEntry.timestamp).getTime()) / 1000;
          }
        } else if (run.finishedAt) {
          duration =
            (new Date(run.finishedAt).getTime() - new Date(histEntry.timestamp).getTime()) / 1000;
        }
      } else if (name === run.currentPhase) {
        status = run.status === "paused" ? "paused" : "active";
      }

      return {
        id: name,
        type: "phase",
        position: { x: idx * (NODE_WIDTH + NODE_GAP), y: 0 },
        data: { label, status, timestamp, duration },
        style: { width: NODE_WIDTH },
      };
    });

    const edges: Edge[] = allPhases.slice(0, -1).map((name, idx) => ({
      id: `${name}->${allPhases[idx + 1]}`,
      source: name,
      target: allPhases[idx + 1]!,
      style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
      animated: false,
    }));

    return { nodes, edges };
  }, [run]);

  const totalWidth = nodes.length * (NODE_WIDTH + NODE_GAP) - NODE_GAP;

  return (
    <div style={{ width: totalWidth, height: NODE_HEIGHT + 20 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--color-base-300, #ccc)" />
      </ReactFlow>
    </div>
  );
}
