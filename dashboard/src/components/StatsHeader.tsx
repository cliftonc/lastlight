import clsx from "clsx";
import { Clock, Radio, SlidersHorizontal } from "lucide-react";
import type { StreamStatus } from "../hooks/useSessionStream";
import { getSessionType } from "../sessionTypes";

interface Props {
  availableSources: string[];
  sourceCounts: Record<string, number>;
  totalCount: number;
  sourceFilter: string | null;
  onFilterChange: (src: string | null) => void;
  hideNoOp: boolean;
  onHideNoOpChange: (v: boolean) => void;
  timeRange: string;
  onTimeRangeChange: (r: string) => void;
  liveCount: number;
  query: string;
  onQueryChange: (q: string) => void;
  streamStatus: StreamStatus;
}

const STATUS_LABEL: Record<StreamStatus, { text: string; color: string }> = {
  live: { text: "live", color: "bg-success" },
  connecting: { text: "connecting", color: "bg-warning animate-pulse" },
  reconnecting: { text: "reconnecting", color: "bg-warning animate-pulse" },
  closed: { text: "offline", color: "bg-error" },
};

const TIME_RANGES = [
  { key: "hour", label: "1h" },
  { key: "day", label: "24h" },
  { key: "week", label: "7d" },
  { key: "all", label: "all" },
];

export function StatsHeader({
  availableSources,
  sourceCounts,
  totalCount,
  sourceFilter,
  onFilterChange,
  hideNoOp,
  onHideNoOpChange,
  timeRange,
  onTimeRangeChange,
  liveCount,
  query,
  onQueryChange,
  streamStatus,
}: Props) {
  const statusInfo = STATUS_LABEL[streamStatus];

  return (
    <header className="bg-base-200 border-b border-base-300 flex items-center gap-3 px-4 h-12 shrink-0">
      <div className="flex items-center gap-2.5 shrink-0">
        <img src="/admin/logo.png" alt="Last Light" width="28" height="28" style={{ width: 28, height: 28, objectFit: "contain" }} />
        <span className="text-base font-bold tracking-tight">Last Light</span>
        <span
          className={clsx("w-2 h-2 rounded-full", statusInfo.color)}
          title={statusInfo.text}
        />
      </div>

      <div className="relative shrink-0 w-64">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search..."
          className="input input-sm input-bordered w-full bg-base-100 text-sm pl-7 pr-7 h-8"
        />
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/40 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        {query && (
          <button
            onClick={() => onQueryChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content text-xs"
            aria-label="clear search"
          >
            x
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0 border-l border-base-300 pl-3">
        <Clock size={12} className="text-base-content/40 shrink-0" />
        <button
          onClick={() => onTimeRangeChange("live")}
          className={clsx(
            "btn btn-xs h-7 min-h-0 font-medium gap-1 px-2",
            timeRange === "live" ? "btn-success" : "btn-ghost text-base-content/50",
          )}
        >
          <Radio size={12} className={liveCount > 0 ? "animate-pulse text-success" : ""} />
          <span className="text-2xs">{liveCount > 0 ? `${liveCount} live` : "live"}</span>
        </button>
        {TIME_RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => onTimeRangeChange(r.key)}
            className={clsx(
              "btn btn-xs h-7 min-h-0 font-mono text-2xs px-2",
              timeRange === r.key ? "btn-primary" : "btn-ghost text-base-content/50",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto flex-nowrap border-l border-base-300 pl-3">
        <SlidersHorizontal size={12} className="text-base-content/40 shrink-0" />
        <button
          onClick={() => onFilterChange(null)}
          className={clsx(
            "btn btn-xs h-7 min-h-0 font-medium shrink-0",
            sourceFilter === null ? "btn-primary" : "btn-ghost text-base-content/60",
          )}
        >
          all <span className="text-2xs opacity-60 ml-0.5">{totalCount}</span>
        </button>
        {availableSources.map((src) => {
          const { Icon, label, color } = getSessionType(src);
          return (
            <button
              key={src}
              onClick={() => onFilterChange(src)}
              className={clsx(
                "btn btn-xs h-7 min-h-0 font-medium gap-1 shrink-0",
                sourceFilter === src ? "btn-primary" : "btn-ghost text-base-content/60",
              )}
            >
              <Icon size={12} className={sourceFilter === src ? "" : color} />
              <span className="text-2xs">{label}</span>
              <span className="text-2xs opacity-50">{sourceCounts[src] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <label className="flex items-center gap-1.5 cursor-pointer text-2xs text-base-content/60 shrink-0">
        <input
          type="checkbox"
          className="checkbox checkbox-xs"
          checked={hideNoOp}
          onChange={(e) => onHideNoOpChange(e.target.checked)}
        />
        hide no-op
      </label>
    </header>
  );
}
