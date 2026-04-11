import { useEffect, useState } from "react";
import { api, type DailyStat } from "../api";

export type StatGranularity = "hour" | "day";

/**
 * Fetches a stats series. `granularity: "hour"` returns rolling N-hour buckets
 * (bucket key `YYYY-MM-DDTHH`); `granularity: "day"` returns N daily buckets
 * (bucket key `YYYY-MM-DD`). Both use the same DailyStat shape — only the
 * `date` field's format differs.
 */
export function useStatsSeries(
  granularity: StatGranularity,
  count: number,
  intervalMs = 60000,
) {
  const [series, setSeries] = useState<DailyStat[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res =
          granularity === "hour"
            ? await api.hourlyStats(count)
            : await api.dailyStats(count);
        if (!cancelled) {
          setSeries(granularity === "hour" ? (res as { hourly: DailyStat[] }).hourly : (res as { daily: DailyStat[] }).daily);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    };
    setLoading(true);
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [granularity, count, intervalMs]);

  return { series, loading };
}
