import { useCallback, useEffect, useMemo, useState } from "react";
import { api, auth, UnauthorizedError } from "./api";
import { StatsHeader } from "./components/StatsHeader";
import { SessionList } from "./components/SessionList";
import { MessageFeed, type MessageOrder } from "./components/MessageFeed";
import { Login } from "./components/Login";
import { useSessionStream } from "./hooks/useSessionStream";

type AuthState = "checking" | "required" | "ok";

const PAGE_SIZE = 50;

function isNoOpSession(s: {
  tool_call_count: number;
  conversation_message_count: number;
}): boolean {
  return s.tool_call_count === 0 && s.conversation_message_count <= 2;
}

function Dashboard() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [userSelected, setUserSelected] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [hideNoOp, setHideNoOp] = useState(true);
  const [timeRange, setTimeRange] = useState<string>("day");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const showLiveOnly = timeRange === "live";
  const [order, setOrder] = useState<MessageOrder>(
    () => (localStorage.getItem("ll-order") as MessageOrder) ?? "newest",
  );

  useEffect(() => {
    localStorage.setItem("ll-order", order);
  }, [order]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);

  const { sessions, status, error } = useSessionStream(limit);

  const availableSources = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.sessionType || "agent"))).sort(),
    [sessions],
  );
  const sourceCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sessions) {
      const t = s.sessionType || "agent";
      out[t] = (out[t] ?? 0) + 1;
    }
    return out;
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    let out = sessions;

    // Time range filter
    if (timeRange === "live") {
      out = out.filter((s) => s.live);
    } else if (timeRange !== "all") {
      const now = Date.now() / 1000;
      const cutoffs: Record<string, number> = { hour: 3600, day: 86400, week: 604800 };
      const cutoff = now - (cutoffs[timeRange] ?? 86400);
      out = out.filter((s) => s.started_at >= cutoff);
    }

    if (sourceFilter) out = out.filter((s) => (s.sessionType || "agent") === sourceFilter);
    if (hideNoOp) out = out.filter((s) => !isNoOpSession(s));
    if (debouncedQuery) {
      const q = debouncedQuery.toLowerCase();
      out = out.filter((s) => {
        const fields = [
          s.id,
          s.title ?? "",
          s.last_assistant_content ?? "",
          s.model ?? "",
          s.source,
        ];
        return fields.some((f) => f.toLowerCase().includes(q));
      });
    }
    return out;
  }, [sessions, sourceFilter, hideNoOp, debouncedQuery, timeRange]);

  useEffect(() => {
    // If current selection is not in filtered list, clear it
    if (selectedId && !filteredSessions.some((s) => s.id === selectedId)) {
      setSelectedId(filteredSessions.length > 0 ? filteredSessions[0]!.id : null);
      setUserSelected(false);
      return;
    }
    // Auto-select first session if nothing selected
    if (!selectedId && filteredSessions.length > 0) {
      setSelectedId(filteredSessions[0]!.id);
    }
  }, [filteredSessions, selectedId]);

  const handleSelect = (id: string) => {
    setUserSelected(true);
    setSelectedId(id);
  };

  const selectedSession = useMemo(
    () => filteredSessions.find((s) => s.id === selectedId),
    [filteredSessions, selectedId],
  );

  const [containers, setContainers] = useState<Array<{ name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { containers: c } = await api.containers();
        if (!cancelled) setContainers(c);
      } catch { /* ignore */ }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const handleTerminate = useCallback(async () => {
    // Find a sandbox container to kill — match by recent activity
    if (containers.length === 0) return;
    // Kill the first matching sandbox (usually only one is live for a session)
    const target = containers[0];
    if (target) {
      await api.killContainer(target.name);
      // Refresh containers
      try {
        const { containers: c } = await api.containers();
        setContainers(c);
      } catch { /* ignore */ }
    }
  }, [containers]);

  return (
    <div className="flex flex-col h-full">
      <StatsHeader
        availableSources={availableSources}
        sourceCounts={sourceCounts}
        totalCount={sessions.length}
        sourceFilter={sourceFilter}
        onFilterChange={setSourceFilter}
        hideNoOp={hideNoOp}
        onHideNoOpChange={setHideNoOp}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
        liveCount={sessions.filter((s) => s.live).length}
        query={query}
        onQueryChange={setQuery}
        streamStatus={status}
      />
      <div className="flex flex-1 overflow-hidden">
        <SessionList
          sessions={filteredSessions}
          error={error}
          selectedId={selectedId}
          onSelect={handleSelect}
          query={debouncedQuery}
          onLoadMore={() => setLimit((l) => l + PAGE_SIZE)}
          totalAvailable={sessions.length}
          showLiveOnly={showLiveOnly}
        />
        <MessageFeed
          sessionId={selectedId}
          order={order}
          onOrderChange={setOrder}
          searchQuery={debouncedQuery}
          isLive={selectedSession?.live}
          onTerminate={handleTerminate}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const { required } = await api.authRequired();
        if (cancelled) return;
        if (!required) {
          setAuthState("ok");
          return;
        }
        if (auth.getToken()) {
          try {
            await api.health();
            if (!cancelled) setAuthState("ok");
            return;
          } catch (e) {
            if (e instanceof UnauthorizedError) {
              if (!cancelled) setAuthState("required");
              return;
            }
          }
        }
        if (!cancelled) setAuthState("required");
      } catch {
        if (!cancelled) setAuthState("required");
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (authState === "checking") {
    return (
      <div className="h-full flex items-center justify-center text-base-content/40">...</div>
    );
  }
  if (authState === "required") {
    return <Login onAuthed={() => setAuthState("ok")} />;
  }
  return <Dashboard />;
}
