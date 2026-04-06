import { useEffect, useRef, useState } from "react";
import { auth, type Message } from "../api";

export type StreamStatus = "connecting" | "live" | "reconnecting" | "closed";

export function useMessageStream(sessionId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<StreamStatus>("closed");
  const [error, setError] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<number>>(() => new Set());

  const latestStreamedIdRef = useRef<number | null>(null);

  useEffect(() => {
    setMessages([]);
    setNewIds(new Set());
    setError(null);
    latestStreamedIdRef.current = null;
    if (!sessionId) {
      setStatus("closed");
      return;
    }

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backfilled = false;

    const connect = () => {
      if (cancelled) return;
      setStatus(backfilled ? "reconnecting" : "connecting");
      const token = auth.getToken();
      const qs = new URLSearchParams();
      if (token) qs.set("token", token);
      const since = latestStreamedIdRef.current ?? -1;
      qs.set("since", String(since));
      const url = `/admin/api/sessions/${encodeURIComponent(sessionId)}/stream?${qs}`;

      es = new EventSource(url);

      es.addEventListener("message", (ev) => {
        if (cancelled) return;
        try {
          const msg = JSON.parse((ev as MessageEvent).data) as Message;
          setMessages((prev) => [...prev, msg]);
          if (backfilled) {
            setNewIds((prev) => {
              const next = new Set(prev);
              next.add(msg.id);
              return next;
            });
            setTimeout(() => {
              setNewIds((prev) => {
                if (!prev.has(msg.id)) return prev;
                const next = new Set(prev);
                next.delete(msg.id);
                return next;
              });
            }, 1500);
          }
          if (typeof msg.id === "number") latestStreamedIdRef.current = msg.id;
        } catch (e) {
          setError((e as Error).message);
        }
      });

      es.addEventListener("ready", () => {
        if (cancelled) return;
        backfilled = true;
        setStatus("live");
        setError(null);
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
  }, [sessionId]);

  return { messages, status, error, newIds };
}
