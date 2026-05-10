import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type ReactFlowInstance,
  Position,
  Handle,
  type NodeProps,
  Background,
  BackgroundVariant,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import type { WorkflowFullDefinition, WorkflowFullPhase } from "../api";

interface PhaseNodeData extends Record<string, unknown> {
  phase: WorkflowFullPhase;
  selected?: boolean;
}

/**
 * Phase node for the read-only definition diagram. Shows the phase label,
 * a small badge row (skill / prompt / loop / approval gate), and visually
 * differentiates `context` phases (no agent run).
 */
function DefPhaseNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  const phase = data.phase;
  const isContext = phase.type === "context";
  const isSkill = !!phase.skill;
  const isPrompt = !!phase.prompt;
  const hasLoop = !!phase.loop || !!phase.generic_loop;
  const gate = phase.approval_gate ?? phase.loop?.approval_gate;

  const containerClass = clsx(
    "flex flex-col items-stretch gap-1.5 px-3 py-2 rounded-lg border shadow-md min-w-[140px] text-left cursor-pointer transition-shadow",
    {
      "border-base-300 bg-base-300/70": !isContext,
      "border-base-300/60 bg-base-200 border-dashed": isContext,
      "ring-2 ring-primary ring-offset-1 ring-offset-base-100": data.selected,
    },
  );

  return (
    <div className={containerClass}>
      <Handle type="target" position={Position.Left} className="!bg-base-300 !border-none !w-1.5 !h-1.5" />
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-base-content/90 truncate">
          {phase.label ?? phase.name}
        </span>
      </div>
      {phase.name !== (phase.label ?? phase.name) && (
        <span className="text-2xs text-base-content/50 font-mono truncate">{phase.name}</span>
      )}
      <div className="flex flex-wrap gap-1">
        {isContext && <span className="badge badge-ghost badge-xs">context</span>}
        {isSkill && (
          <span className="badge badge-info badge-xs font-mono normal-case">skill: {phase.skill}</span>
        )}
        {isPrompt && (
          <span className="badge badge-info badge-xs font-mono normal-case">prompt</span>
        )}
        {hasLoop && <span className="badge badge-warning badge-xs">loop</span>}
        {gate && <span className="badge badge-error badge-xs">gate</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-base-300 !border-none !w-1.5 !h-1.5" />
    </div>
  );
}

const nodeTypes = { defPhase: DefPhaseNode };

const NODE_WIDTH = 180;
const NODE_GAP = 60;
const ROW_HEIGHT = 110;

/**
 * Compute layered positions for a DAG. Each phase's column is `1 + max(column
 * of its dependencies)`; rows within a column are assigned in declaration
 * order. Used when any phase has `depends_on`.
 */
function layoutDag(phases: WorkflowFullPhase[]): Map<string, { x: number; y: number }> {
  const colByName = new Map<string, number>();
  for (const phase of phases) {
    const deps = phase.depends_on ?? [];
    let col = 0;
    for (const dep of deps) {
      const depCol = colByName.get(dep);
      if (depCol !== undefined) col = Math.max(col, depCol + 1);
    }
    colByName.set(phase.name, col);
  }
  const rowByCol = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const phase of phases) {
    const col = colByName.get(phase.name) ?? 0;
    const row = rowByCol.get(col) ?? 0;
    rowByCol.set(col, row + 1);
    out.set(phase.name, { x: col * (NODE_WIDTH + NODE_GAP), y: row * ROW_HEIGHT });
  }
  return out;
}

/** Linear left-to-right layout — every phase one column to the right of the previous. */
function layoutLinear(phases: WorkflowFullPhase[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  phases.forEach((p, i) => {
    out.set(p.name, { x: i * (NODE_WIDTH + NODE_GAP), y: 0 });
  });
  return out;
}

interface Props {
  definition: WorkflowFullDefinition;
  selectedPhase: string | null;
  onPhaseClick: (phaseName: string) => void;
  height?: number | string;
}

export function WorkflowDefinitionDiagram({
  definition,
  selectedPhase,
  onPhaseClick,
  height = 320,
}: Props) {
  const isDag = useMemo(
    () => definition.phases.some((p) => Array.isArray(p.depends_on) && p.depends_on.length > 0),
    [definition.phases],
  );

  const positions = useMemo(
    () => (isDag ? layoutDag(definition.phases) : layoutLinear(definition.phases)),
    [isDag, definition.phases],
  );

  const nodes: Node<PhaseNodeData>[] = useMemo(() => {
    return definition.phases.map((phase) => {
      const pos = positions.get(phase.name) ?? { x: 0, y: 0 };
      return {
        id: phase.name,
        type: "defPhase",
        position: pos,
        data: { phase, selected: phase.name === selectedPhase },
        draggable: false,
      };
    });
  }, [definition.phases, positions, selectedPhase]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    if (isDag) {
      for (const phase of definition.phases) {
        for (const dep of phase.depends_on ?? []) {
          out.push({
            id: `${dep}->${phase.name}`,
            source: dep,
            target: phase.name,
            type: "smoothstep",
            animated: false,
            style: { stroke: "rgb(var(--bc) / 0.25)", strokeWidth: 1.5 },
          });
        }
      }
    } else {
      for (let i = 1; i < definition.phases.length; i++) {
        const prev = definition.phases[i - 1]!.name;
        const cur = definition.phases[i]!.name;
        out.push({
          id: `${prev}->${cur}`,
          source: prev,
          target: cur,
          type: "smoothstep",
          animated: false,
          style: { stroke: "rgb(var(--bc) / 0.25)", strokeWidth: 1.5 },
        });
      }
    }
    return out;
  }, [definition.phases, isDag]);

  // Re-center the diagram whenever the wrapper size changes (e.g. when a
  // phase is selected and the diagram section shrinks via the resizable
  // divider). React Flow's `fitView` prop only runs on mount, so we hold a
  // reference to the flow instance and refit on every resize tick.
  // Guard against the xyflow async tick accessing a torn-down store after
  // unmount / node-list change — manifested as
  // `Cannot read properties of undefined (reading 'payload')`.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<PhaseNodeData>, Edge> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const el = wrapperRef.current;
    if (!el) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        const flow = flowRef.current;
        if (!flow) return;
        try {
          if (flow.getNodes().length === 0) return;
          flow.fitView({ padding: 0.2 });
        } catch {
          /* fitView raced against unmount — safe to ignore */
        }
      });
    });
    ro.observe(el);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      flowRef.current = null;
    };
  }, []);

  return (
    <div ref={wrapperRef} style={{ height }} className="rounded border border-base-300 bg-base-200/30">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_, node) => onPhaseClick(node.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgb(var(--bc) / 0.08)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
