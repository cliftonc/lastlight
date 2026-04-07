import { useEffect, useState } from "react";
import { api, type RateLimit } from "../api";
import { Activity, Zap, Clock, AlertTriangle } from "lucide-react";

function toMap(limits: RateLimit[]): Record<string, RateLimit> {
  const m: Record<string, RateLimit> = {};
  for (const l of limits) m[l.resource] = l;
  return m;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

function resetIn(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h`;
  return `${Math.round(diff / 86400_000)}d`;
}

export function UsageFooter() {
  const [limits, setLimits] = useState<Record<string, RateLimit>>({});

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { limits: l } = await api.rateLimits();
        if (!cancelled) setLimits(toMap(l));
      } catch { /* ignore */ }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const capacity = limits["subscription:status"];
  const overage = limits["subscription:using_overage"];
  const resetsAt = limits["subscription:resets_at"];
  const exec1h = limits["usage:executions_1h"];
  const exec24h = limits["usage:executions_24h"];
  const turns1h = limits["usage:turns_1h"];
  const turns24h = limits["usage:turns_24h"];

  // Only show subscription status when we have actual data from a cron check
  const hasCapacityData = !!capacity;
  const hasUsageData = !!exec1h;

  if (!hasCapacityData && !hasUsageData) {
    return (
      <footer className="bg-base-200 border-t border-base-300 flex items-center gap-3 px-4 h-8 shrink-0 text-2xs text-base-content/40">
        <Activity size={10} />
        <span>Waiting for first usage check...</span>
      </footer>
    );
  }

  const isAllowed = capacity?.remaining === 1;
  const isUsingOverage = overage?.remaining === 1;

  return (
    <footer className="bg-base-200 border-t border-base-300 flex items-center gap-4 px-4 h-8 shrink-0 text-2xs">
      {/* Capacity status — only show when we have data */}
      {hasCapacityData && (
        <div className="flex items-center gap-1.5">
          <Zap size={11} className={isAllowed ? "text-success" : "text-error"} />
          <span className={isAllowed ? "text-success" : "text-error font-semibold"}>
            {isAllowed ? "API OK" : "Rate limited"}
          </span>
          {isUsingOverage && (
            <span className="text-warning flex items-center gap-0.5">
              <AlertTriangle size={10} />
              overage
            </span>
          )}
        </div>
      )}

      {/* Reset times */}
      {hasCapacityData && resetsAt && (
        <div className="flex items-center gap-1 text-base-content/50">
          <Clock size={10} />
          resets in {resetIn(resetsAt.reset_at)}
        </div>
      )}

      {hasCapacityData && hasUsageData && (
        <div className="border-l border-base-300 h-4" />
      )}

      {/* Execution stats */}
      {hasUsageData && (
        <div className="flex items-center gap-1 text-base-content/50">
          <Activity size={10} />
          <span>1h: {exec1h?.remaining ?? 0} runs, {turns1h?.remaining ?? 0} turns</span>
          <span className="text-base-content/30">|</span>
          <span>24h: {exec24h?.remaining ?? 0} runs, {turns24h?.remaining ?? 0} turns</span>
        </div>
      )}

      {/* Last checked */}
      {capacity?.updated_at && (
        <>
          <div className="flex-1" />
          <span className="text-base-content/30">
            checked {relativeTime(capacity.updated_at)}
          </span>
        </>
      )}
    </footer>
  );
}
