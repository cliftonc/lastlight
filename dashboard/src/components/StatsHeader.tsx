import clsx from "clsx";
import { useStats } from "../hooks/useStats";
import type { StreamStatus } from "../hooks/useSessionStream";

const SOURCE_BADGE: Record<string, string> = {
  webhook: "badge-warning",
  cron: "badge-success",
  cli: "badge-ghost",
  api: "badge-info",
};

interface Props {
  availableSources: string[];
  sourceCounts: Record<string, number>;
  totalCount: number;
  sourceFilter: string | null;
  onFilterChange: (src: string | null) => void;
  hideNoOp: boolean;
  onHideNoOpChange: (v: boolean) => void;
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

export function StatsHeader({
  availableSources,
  sourceCounts,
  totalCount,
  sourceFilter,
  onFilterChange,
  hideNoOp,
  onHideNoOpChange,
  query,
  onQueryChange,
  streamStatus,
}: Props) {
  const stats = useStats();
  const statusInfo = STATUS_LABEL[streamStatus];

  return (
    <header className="bg-base-200 border-b border-base-300 flex items-center gap-3 px-3 h-12 shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <div className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">Last Light</span>
          <span className="flex items-center gap-1 text-2xs text-base-content/50 mt-0.5">
            <span
              className={clsx("w-1.5 h-1.5 rounded-full", statusInfo.color)}
              title={statusInfo.text}
            />
            {statusInfo.text}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-base-content/60 shrink-0 border-l border-base-300 pl-3 font-mono">
        {stats ? (
          <>
            <span>
              <span className="text-base-content font-semibold">{stats.today_count}</span>{" "}
              today
            </span>
            <span className="text-base-content/30">-</span>
            <span>
              <span className="text-base-content font-semibold">{stats.running}</span>{" "}
              running
            </span>
          </>
        ) : (
          <span className="text-base-content/40">...</span>
        )}
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

      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto flex-nowrap">
        <button
          onClick={() => onFilterChange(null)}
          className={clsx(
            "btn btn-xs h-7 min-h-0 font-medium shrink-0",
            sourceFilter === null ? "btn-primary" : "btn-ghost text-base-content/60",
          )}
        >
          all <span className="text-2xs opacity-60 ml-0.5">{totalCount}</span>
        </button>
        {availableSources.map((src) => (
          <button
            key={src}
            onClick={() => onFilterChange(src)}
            className={clsx(
              "btn btn-xs h-7 min-h-0 font-medium gap-1.5 shrink-0",
              sourceFilter === src ? "btn-primary" : "btn-ghost text-base-content/60",
            )}
          >
            <span className={clsx("badge badge-xs", SOURCE_BADGE[src] ?? "badge-ghost")}>
              {src}
            </span>
            <span className="text-2xs opacity-60">{sourceCounts[src] ?? 0}</span>
          </button>
        ))}
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
