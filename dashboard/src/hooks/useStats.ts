import { useEffect, useState } from "react";
import { api, type Stats } from "../api";

export function useStats(intervalMs = 10000) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const s = await api.stats();
        if (!cancelled) setStats(s);
      } catch {
        // ignore
      }
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [intervalMs]);

  return stats;
}
