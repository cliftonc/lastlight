import { useEffect, useState } from "react";
import { auth, type Session } from "../api";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

/**
 * @param sourcePath base path of the session source on the admin API.
 *   Defaults to `/admin/api/sessions` (sandbox/workflow runs); pass
 *   `/admin/api/chat-sessions` for the in-process chat skill stream.
 */
export function useSessionStream(
  limit: number,
  sourcePath: string = "/admin/api/sessions",
) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset list whenever the source changes — otherwise the previously
    // loaded sessions from the other source linger until the new stream
    // pushes data, which it may never do if the new source is empty.
    setSessions([]);
    setStatus("connecting");

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      const token = auth.getToken();
      const qs = new URLSearchParams();
      if (token) qs.set("token", token);
      qs.set("limit", String(limit));
      const url = `${sourcePath}/stream?${qs}`;

      es = new EventSource(url);

      es.addEventListener("sessions", (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { sessions: Session[] };
          setSessions(data.sessions);
          setStatus("live");
          setError(null);
        } catch (e) {
          setError((e as Error).message);
        }
      });

      es.addEventListener("error", (ev) => {
        if (cancelled) return;
        const data = (ev as MessageEvent).data;
        if (data) {
          try {
            setError((JSON.parse(data) as { message?: string }).message ?? "stream error");
          } catch {
            /* ignore */
          }
        }
      });

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
      setStatus("closed");
    };
  }, [limit, sourcePath]);

  return { sessions, status, error };
}
