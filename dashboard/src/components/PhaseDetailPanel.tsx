import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  api,
  type WorkflowDefinition,
  type WorkflowPhaseDefinition,
  type WorkflowRun,
  type WorkflowRunExecution,
} from "../api";

/**
 * In-SPA navigation to the Artifacts editor for a specific doc. Pushes the
 * deep-link params and fires a synthetic popstate so every `useUrlState` hook
 * (App's `tab`, ArtifactsPage's repo/key/doc) re-reads — no full reload, no
 * callback threading through the run-detail component tree.
 */
function openArtifact(repo: string, key: string, doc: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", "artifacts");
  url.searchParams.set("repo", repo);
  url.searchParams.set("key", key);
  url.searchParams.set("doc", doc);
  window.history.pushState(null, "", url.toString());
  window.dispatchEvent(new PopStateEvent("popstate"));
}

interface Props {
  phaseName: string;
  run: WorkflowRun;
  definition: WorkflowDefinition | null;
  /** Most recent execution for this phase, if one exists. */
  execution: WorkflowRunExecution | null;
  /**
   * Number of executions recorded for this phase. Surfaced so the user knows
   * a loop phase had multiple iterations even though we only show the latest.
   */
  totalExecutions: number;
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m${r}s`;
}

function fmtCost(usd?: number): string {
  if (usd === undefined || usd === null) return "—";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTokens(n?: number): string {
  if (n === undefined || n === null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString();
}

function fmtExtension(v: {
  status: string;
  mode?: string;
  provider?: string;
  toolCount?: number;
  reason?: string;
}): string {
  const parts: string[] = [v.status];
  if (v.mode) parts.push(v.mode);
  if (v.provider) parts.push(v.provider);
  if (typeof v.toolCount === "number") {
    parts.push(`${v.toolCount} tool${v.toolCount === 1 ? "" : "s"}`);
  }
  if (v.status !== "configured" && v.reason) parts.push(v.reason);
  return parts.join(" · ");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs font-semibold uppercase tracking-wider text-base-content/40">
        {label}
      </span>
      <span className="text-xs text-base-content/80 font-mono break-words">{children}</span>
    </div>
  );
}

export function PhaseDetailPanel({ phaseName, run, definition, execution, totalExecutions }: Props) {
  // Look up the phase in the workflow definition (may be missing for dynamic
  // phases like reviewer_recheck_1 / reviewer_fix_1 — we still show what we know).
  const phaseDef: WorkflowPhaseDefinition | undefined = definition?.phases.find(
    (p) => p.name === phaseName,
  );

  // Find this phase's history entry — used for status colour when no execution row exists.
  const historyEntry = run.phaseHistory.find((h) => h.phase === phaseName);

  const statusLabel = execution
    ? execution.success === true
      ? "succeeded"
      : execution.success === false
        ? "failed"
        : "running"
    : historyEntry
      ? historyEntry.success
        ? "succeeded"
        : "failed"
      : phaseName === run.currentPhase
        ? run.status === "paused"
          ? "paused"
          : "active"
        : "pending";

  const statusClass = clsx("badge badge-xs font-mono", {
    "badge-success": statusLabel === "succeeded",
    "badge-error": statusLabel === "failed",
    "badge-info": statusLabel === "active" || statusLabel === "running",
    "badge-warning": statusLabel === "paused",
    "badge-ghost": statusLabel === "pending",
  });

  // Second tab groups "what got loaded" for this run — agentic-pi extensions
  // (tool loading) and skills (skill loading). The count drives the tab badge.
  const extensionCount = execution?.extensions ? Object.keys(execution.extensions).length : 0;
  const skillCount = execution?.skills?.skills.length ?? 0;
  const loadedCount = extensionCount + skillCount;

  // Build-asset ("Artifacts") handoff docs live per-run under
  // <owner>/<repo>/<issueKey>/, keyed by the run's issueDir (server mode only;
  // empty in repo mode). Derive the lookup coordinates from the run.
  const [owner, repoName] = (run.repo ?? "").split("/", 2);
  const issueDir = typeof run.context?.issueDir === "string" ? run.context.issueDir : "";
  const issueKey = issueDir.replace(/^\.lastlight\//, "");

  const [artifacts, setArtifacts] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!owner || !repoName || !issueKey) {
      setArtifacts([]);
      return;
    }
    api.listArtifactFiles(owner, repoName, issueKey)
      .then((res) => { if (!cancelled) setArtifacts(res.files); })
      .catch(() => { if (!cancelled) setArtifacts([]); });
    return () => { cancelled = true; };
  }, [owner, repoName, issueKey]);

  const [tab, setTab] = useState<"details" | "loaded" | "artifacts">("details");

  return (
    <div className="flex flex-col gap-3 p-3 text-xs">
      <div>
        <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
          Phase
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-base-content text-sm">
            {phaseDef?.label ?? phaseName}
          </span>
          <span className={statusClass}>{statusLabel}</span>
        </div>
        {phaseDef?.label && phaseDef.label !== phaseName && (
          <div className="text-2xs text-base-content/40 font-mono mt-0.5">{phaseName}</div>
        )}
      </div>

      {/* Tabs — Details (execution/usage/session) vs Loaded (extensions/skills) */}
      <div className="flex gap-1 border-b border-base-300 -mx-3 px-3">
        <TabButton active={tab === "details"} onClick={() => setTab("details")}>
          Details
        </TabButton>
        <TabButton active={tab === "loaded"} onClick={() => setTab("loaded")}>
          Loaded{loadedCount > 0 ? ` (${loadedCount})` : ""}
        </TabButton>
        {artifacts.length > 0 && (
          <TabButton active={tab === "artifacts"} onClick={() => setTab("artifacts")}>
            Artifacts ({artifacts.length})
          </TabButton>
        )}
      </div>

      {tab === "details" && (
        <div className="flex flex-col gap-4">
          {phaseDef && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">{phaseDef.type}</Field>
              {phaseDef.hasLoop && <Field label="Loop">yes</Field>}
              {phaseDef.approvalGate && (
                <Field label="Approval Gate">{phaseDef.approvalGate}</Field>
              )}
            </div>
          )}

          {!phaseDef && (
            <div className="text-2xs text-base-content/50 italic">
              Dynamic phase (not declared in the workflow YAML — likely a loop iteration).
            </div>
          )}

          {!execution && (
            <div className="text-xs text-base-content/50 border border-base-300/40 bg-base-200/30 rounded px-3 py-2">
              No execution recorded yet.
            </div>
          )}

          {execution && (
            <>
              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
                  Execution
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Started">{fmtTime(execution.startedAt)}</Field>
                  <Field label="Finished">{fmtTime(execution.finishedAt)}</Field>
                  <Field label="Duration">{fmtDuration(execution.durationMs)}</Field>
                  <Field label="API Time">{fmtDuration(execution.apiDurationMs)}</Field>
                  <Field label="Turns">{execution.turns ?? "—"}</Field>
                  <Field label="Stop Reason">{execution.stopReason ?? "—"}</Field>
                </div>
              </div>

              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
                  Usage
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Cost">{fmtCost(execution.costUsd)}</Field>
                  <Field label="Output Tokens">{fmtTokens(execution.outputTokens)}</Field>
                  <Field label="Input Tokens">{fmtTokens(execution.inputTokens)}</Field>
                  <Field label="Cache Read">{fmtTokens(execution.cacheReadInputTokens)}</Field>
                  <Field label="Cache Create">{fmtTokens(execution.cacheCreationInputTokens)}</Field>
                </div>
              </div>

              {execution.error && (
                <div>
                  <div className="text-2xs font-semibold uppercase tracking-wider text-error/80 mb-1">
                    Error
                  </div>
                  <div className="text-2xs text-error/80 font-mono break-words border border-error/30 bg-error/5 rounded px-2 py-1">
                    {execution.error}
                  </div>
                </div>
              )}

              <div>
                <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
                  Session
                </div>
                {execution.sessionId ? (
                  <div className="text-2xs font-mono text-base-content/70 break-all">
                    {execution.sessionId}
                  </div>
                ) : (
                  <div className="text-2xs text-base-content/50 italic">
                    Session not captured for this run.
                  </div>
                )}
              </div>

              {totalExecutions > 1 && (
                <div className="text-2xs text-base-content/40 italic">
                  {totalExecutions} executions recorded for this phase — showing the most recent.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === "loaded" && (
        <div className="flex flex-col gap-4">
          {!execution && (
            <div className="text-xs text-base-content/50 border border-base-300/40 bg-base-200/30 rounded px-3 py-2">
              No execution recorded yet.
            </div>
          )}

          {execution && loadedCount === 0 && (
            <div className="text-2xs text-base-content/40 italic">
              No extensions or skills were loaded for this run.
            </div>
          )}

          {extensionCount > 0 && (
            <div>
              <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
                Extensions
              </div>
              <div className="grid grid-cols-2 gap-3">
                {Object.entries(execution!.extensions!).map(([name, v]) => (
                  <Field key={name} label={name}>
                    {fmtExtension(v)}
                  </Field>
                ))}
              </div>
            </div>
          )}

          {execution?.skills && <SkillsSection skills={execution.skills} />}
        </div>
      )}

      {tab === "artifacts" && (
        <div className="flex flex-col gap-2">
          <div className="text-2xs text-base-content/40">
            Handoff docs for this run — click to open in the editor.
          </div>
          <ul className="flex flex-col gap-1">
            {artifacts.map((f) => (
              <li key={f}>
                <button
                  onClick={() => openArtifact(run.repo!, issueKey, f)}
                  className="w-full text-left px-2 py-1 rounded text-xs font-mono text-primary hover:bg-base-300/50 truncate"
                >
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "px-2 py-1 text-2xs font-mono border-b-2 -mb-px transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-base-content/60 hover:text-base-content",
      )}
    >
      {children}
    </button>
  );
}

/** Skill-loading detail — the counterpart to the Extensions grid. */
function SkillsSection({
  skills,
}: {
  skills: NonNullable<WorkflowRunExecution["skills"]>;
}) {
  const summary = [
    skills.status,
    `${skills.discovered} discovered`,
    ...(skills.noSkills ? ["default discovery off"] : []),
  ].join(" · ");
  return (
    <div>
      <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-1">
        Skills
      </div>
      <div className="text-2xs text-base-content/50 font-mono mb-1.5">{summary}</div>
      {skills.skills.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {skills.skills.map((s) => (
            <li key={s.source} className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-base-content/80 break-all">{s.name}</span>
              {!s.modelInvocable && <span className="badge badge-ghost badge-xs">manual</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-2xs text-base-content/40 italic">No skills discovered.</div>
      )}
    </div>
  );
}
