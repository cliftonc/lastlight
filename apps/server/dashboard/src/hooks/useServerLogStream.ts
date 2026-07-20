import { useEffect, useRef, useState } from "react";
import { auth } from "../api";
import type { StreamStatus } from "./useSessionStream";

/**
 * Live tail of a `lastlight-*` container's `docker logs` over SSE
 * (`GET /admin/api/server/logs/stream`). The server emits the last `tail`
 * lines then follows; we keep a ring buffer capped at `maxRows` so a
 * long-running follow can't grow unbounded.
 *
 * This is the "Live" half of the Logs viewer — the paused/time-windowed
 * snapshot uses the one-shot `api.serverLogs` endpoint instead (the stream
 * endpoint always tails from now and has no `since`).
 */
export function useServerLogStream(
  container: string | null,
  maxRows: number,
  enabled: boolean,
) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<StreamStatus>("closed");
  const maxRowsRef = useRef(maxRows);
  maxRowsRef.current = maxRows;

  useEffect(() => {
    if (!enabled || !container) {
      setStatus("closed");
      return;
    }

    setLines([]);
    setStatus("connecting");

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const token = auth.getToken();
      const qs = new URLSearchParams();
      if (token) qs.set("token", token);
      qs.set("container", container);
      qs.set("tail", String(maxRowsRef.current));
      es = new EventSource(`/admin/api/server/logs/stream?${qs}`);

      es.onmessage = (ev) => {
        if (cancelled) return;
        // The stream signals a bad container as a JSON `{error}` frame; every
        // other frame is a raw `docker logs --timestamps` line.
        if (ev.data.startsWith("{")) {
          try {
            if ((JSON.parse(ev.data) as { error?: string }).error) return;
          } catch {
            /* not JSON — fall through and treat as a log line */
          }
        }
        setStatus("live");
        setLines((prev) => {
          const next = prev.length >= maxRowsRef.current ? prev.slice(prev.length - maxRowsRef.current + 1) : prev;
          return [...next, ev.data];
        });
      };

      es.onerror = () => {
        if (cancelled) return;
        es?.close();
        es = null;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [container, enabled]); // maxRows read via ref — changing it shouldn't reconnect

  return { lines, status, setLines };
}
