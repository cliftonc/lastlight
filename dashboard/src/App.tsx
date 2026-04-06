import { useEffect, useMemo, useState } from "react";
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
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
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
    () => Array.from(new Set(sessions.map((s) => s.source))).sort(),
    [sessions],
  );
  const sourceCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sessions) out[s.source] = (out[s.source] ?? 0) + 1;
    return out;
  }, [sessions]);

  const filteredSessions = useMemo(() => {
    let out = sessions;
    if (sourceFilter) out = out.filter((s) => s.source === sourceFilter);
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
  }, [sessions, sourceFilter, hideNoOp, debouncedQuery]);

  useEffect(() => {
    if (userSelected || selectedId) return;
    if (filteredSessions.length > 0) {
      setSelectedId(filteredSessions[0]!.id);
    }
  }, [filteredSessions, selectedId, userSelected]);

  const handleSelect = (id: string) => {
    setUserSelected(true);
    setSelectedId(id);
  };

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
        />
        <MessageFeed
          sessionId={selectedId}
          order={order}
          onOrderChange={setOrder}
          searchQuery={debouncedQuery}
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
