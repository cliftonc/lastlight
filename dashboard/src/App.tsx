import { useCallback, useEffect, useMemo, useState } from "react";
import { api, auth, UnauthorizedError } from "./api";
import { StatsHeader } from "./components/StatsHeader";
import { SessionList } from "./components/SessionList";
import { SessionFilters } from "./components/SessionFilters";
import { MessageFeed, type MessageOrder } from "./components/MessageFeed";
import { Login } from "./components/Login";
import { useSessionStream } from "./hooks/useSessionStream";
import { UsageFooter } from "./components/UsageFooter";
import { WorkflowList } from "./components/WorkflowList";
import { HomePage } from "./components/HomePage";
import {
  useUrlState,
  enumParser,
  enumSerializer,
  stringParser,
  stringSerializer,
  nullableStringParser,
  nullableStringSerializer,
  boolParser,
  boolSerializer,
} from "./hooks/useUrlState";

type AuthState = "checking" | "required" | "ok";
type Tab = "home" | "sessions" | "workflows";

const PAGE_SIZE = 50;

const TABS = ["home", "workflows", "sessions"] as const;
const TIME_RANGES = ["hour", "day", "week", "all", "live"] as const;

function isNoOpSession(s: {
  tool_call_count: number;
  conversation_message_count: number;
}): boolean {
  return s.tool_call_count === 0 && s.conversation_message_count <= 2;
}

function Dashboard() {
  // ── Filters & navigation, all persisted to the URL ─────────────────────
  const [tab, setTab] = useUrlState<Tab>(
    "tab",
    "home",
    enumParser(TABS, "home"),
    enumSerializer<Tab>("home"),
  );
  type TimeRange = (typeof TIME_RANGES)[number];
  const [timeRange, setTimeRange] = useUrlState<TimeRange>(
    "range",
    "day",
    enumParser(TIME_RANGES, "day"),
    enumSerializer<TimeRange>("day"),
  );
  const [query, setQuery] = useUrlState<string>(
    "q",
    "",
    stringParser,
    stringSerializer,
  );
  const [sourceFilter, setSourceFilter] = useUrlState<string | null>(
    "source",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const [hideNoOp, setHideNoOp] = useUrlState<boolean>(
    "noop",
    true,
    boolParser(true),
    boolSerializer(true),
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [_userSelected, setUserSelected] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
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
    if (selectedId && !filteredSessions.some((s) => s.id === selectedId)) {
      setSelectedId(filteredSessions.length > 0 ? filteredSessions[0]!.id : null);
      setUserSelected(false);
      return;
    }
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

  // ── Workflow live count (for the header pill on the workflows tab) ─────
  // Polled independently of the WorkflowList's own data load so the count
  // stays accurate even when the user is on the sessions tab.
  const [workflowLiveCount, setWorkflowLiveCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.workflowRuns({ limit: 1, status: "active" });
        if (!cancelled) setWorkflowLiveCount(res.total);
      } catch {
        /* ignore */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const sessionLiveCount = useMemo(
    () => sessions.filter((s) => s.live).length,
    [sessions],
  );

  const [containers, setContainers] = useState<Array<{ name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { containers: c } = await api.containers();
        if (!cancelled) setContainers(c);
      } catch {
        /* ignore */
      }
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const handleTerminate = useCallback(async () => {
    if (containers.length === 0) return;
    const target = containers[0];
    if (target) {
      await api.killContainer(target.name);
      try {
        const { containers: c } = await api.containers();
        setContainers(c);
      } catch {
        /* ignore */
      }
    }
  }, [containers]);

  // The header's "live" pill shows whichever count is relevant for the active
  // tab — workflow runs vs raw sessions.
  const headerLiveCount = tab === "sessions" ? sessionLiveCount : workflowLiveCount;

  return (
    <div className="flex flex-col h-full">
      <StatsHeader
        timeRange={timeRange}
        onTimeRangeChange={(r) => setTimeRange(r as TimeRange)}
        liveCount={headerLiveCount}
        query={query}
        onQueryChange={(q) => {
          setQuery(q);
          // Searching from the home page is meaningless — Home has no
          // searchable list. Hop the user to Workflows so the query has
          // somewhere to apply.
          if (tab === "home" && q.length > 0) setTab("workflows");
        }}
        streamStatus={status}
      />
      <div className="flex border-b border-base-300 bg-base-200/60 px-4 gap-1">
        <button
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${tab === "home" ? "border-primary text-primary" : "border-transparent text-base-content/50 hover:text-base-content/80"}`}
          onClick={() => setTab("home")}
        >
          Home
        </button>
        <button
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${tab === "workflows" ? "border-primary text-primary" : "border-transparent text-base-content/50 hover:text-base-content/80"}`}
          onClick={() => setTab("workflows")}
        >
          Workflows
        </button>
        <button
          className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px ${tab === "sessions" ? "border-primary text-primary" : "border-transparent text-base-content/50 hover:text-base-content/80"}`}
          onClick={() => setTab("sessions")}
        >
          Sessions
        </button>
      </div>
      {tab === "home" ? (
        <HomePage
          onSelectWorkflow={(id) => {
            // Pre-write `run` into the URL so WorkflowList picks it up the
            // moment it mounts after the tab switch (its useUrlState reads
            // the URL on first render).
            const url = new URL(window.location.href);
            url.searchParams.set("run", id);
            window.history.replaceState(null, "", url.toString());
            setTab("workflows");
          }}
        />
      ) : tab === "sessions" ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          <SessionFilters
            availableSources={availableSources}
            sourceCounts={sourceCounts}
            totalCount={sessions.length}
            sourceFilter={sourceFilter}
            onFilterChange={setSourceFilter}
            hideNoOp={hideNoOp}
            onHideNoOpChange={setHideNoOp}
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
      ) : (
        <WorkflowList timeRange={timeRange} query={debouncedQuery} />
      )}
      <UsageFooter />
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
