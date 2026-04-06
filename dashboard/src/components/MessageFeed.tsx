import { useEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { useMessageStream, type StreamStatus } from "../hooks/useMessageStream";
import { toBaseMessages } from "../adapters/lastlightToTimeline";
import { processMessages, isToolPair } from "../timeline";
import type { TimelineItem as TimelineItemT } from "../timeline";
import { TimelineItem } from "./timeline/TimelineItem";

export type MessageOrder = "newest" | "oldest";

interface Props {
  sessionId: string | null;
  order: MessageOrder;
  onOrderChange: (o: MessageOrder) => void;
  searchQuery: string;
}

const STATUS_DOT: Record<StreamStatus, string> = {
  live: "bg-success",
  connecting: "bg-warning animate-pulse",
  reconnecting: "bg-warning animate-pulse",
  closed: "bg-error",
};

function matchesQuery(text: string, q: string): boolean {
  if (!q) return true;
  return text.toLowerCase().includes(q.toLowerCase());
}

function isUserMessage(item: TimelineItemT): boolean {
  return !isToolPair(item) && item.message.type === "user";
}

export function MessageFeed({ sessionId, order, onOrderChange, searchQuery }: Props) {
  const { messages, status, error, newIds } = useMessageStream(sessionId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledAwayRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  const items = useMemo(() => {
    const base = toBaseMessages(messages);
    const processed = processMessages(base);
    const filtered = searchQuery
      ? processed.filter((item) => {
          const texts: string[] = [];
          if (item.kind === "single") {
            const c = item.message.content as { text?: string } | undefined;
            if (c?.text) texts.push(c.text);
          } else {
            texts.push(item.toolName);
            texts.push(JSON.stringify((item.use.content as { input?: unknown })?.input ?? {}));
            const resultContent = (item.result?.content as { content?: unknown })?.content;
            if (resultContent) texts.push(String(resultContent).slice(0, 2000));
          }
          return texts.some((t) => matchesQuery(t, searchQuery));
        })
      : processed;
    return order === "newest" ? [...filtered].reverse() : filtered;
  }, [messages, order, searchQuery]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (!grew || userScrolledAwayRef.current) return;
    if (order === "newest") {
      el.scrollTop = 0;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, order]);

  useEffect(() => {
    userScrolledAwayRef.current = true;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    prevMessageCountRef.current = 0;
  }, [sessionId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (order === "newest") {
      userScrolledAwayRef.current = el.scrollTop > 50;
    } else {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      userScrolledAwayRef.current = !atBottom;
    }
  };

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-base-content/40 text-sm">
        Select a session from the left to view its messages.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-2 border-b border-base-300 bg-base-200/80 backdrop-blur flex items-center gap-3 shrink-0">
        <div className={clsx("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[status])} title={status} />
        <span className="text-xs font-mono text-base-content/60 truncate">{sessionId}</span>
        <span className="text-base-content/30 text-xs">-</span>
        <span className="text-xs text-base-content/60">
          <span className="text-base-content font-semibold">{items.length}</span>
          {searchQuery && (
            <span className="text-base-content/50"> / {messages.length}</span>
          )}{" "}
          {searchQuery ? "matching" : "messages"}
        </span>
        {error && <span className="text-xs text-error">- {error}</span>}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            onClick={() => onOrderChange("newest")}
            className={clsx(
              "btn btn-xs h-6 min-h-0",
              order === "newest" ? "btn-primary" : "btn-ghost text-base-content/60",
            )}
          >
            newest
          </button>
          <button
            onClick={() => onOrderChange("oldest")}
            className={clsx(
              "btn btn-xs h-6 min-h-0",
              order === "oldest" ? "btn-primary" : "btn-ghost text-base-content/60",
            )}
          >
            oldest
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-base-100 px-4 py-3 space-y-2"
      >
        {items.map((item) => {
          const isNew =
            item.kind === "single"
              ? newIds.has(Number(item.message.id.replace(/-text$/, "")))
              : newIds.has(Number(item.use.id.split("-")[0]));
          if (isUserMessage(item)) {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="w-fit max-w-[85%] sm:max-w-[70%] md:max-w-[60%] min-w-0">
                  <TimelineItem item={item} isNew={isNew} />
                </div>
              </div>
            );
          }
          return <TimelineItem key={item.id} item={item} isNew={isNew} />;
        })}
        {items.length === 0 && (
          <div className="p-6 text-center text-base-content/40 text-sm">
            {searchQuery ? "no messages match search" : "no messages yet"}
          </div>
        )}
      </div>
    </div>
  );
}
