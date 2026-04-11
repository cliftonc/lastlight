import { useEffect, useState } from "react";
import { api, type DailyStat } from "../api";

export function useDailyStats(days = 30, intervalMs = 60000) {
  const [daily, setDaily] = useState<DailyStat[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.dailyStats(days);
        if (!cancelled) {
          setDaily(res.daily);
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
  }, [days, intervalMs]);

  return { daily, loading };
}
