import clsx from "clsx";
import type { Session } from "../api";

const SOURCE_COLOR: Record<string, string> = {
  webhook: "text-warning",
  cron: "text-success",
  cli: "text-base-content/60",
  api: "text-info",
  unknown: "text-base-content/60",
};

function timeAgo(unix: number | null): string {
  if (unix == null) return "";
  const secs = Math.floor(Date.now() / 1000 - unix);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function duration(session: Session): string {
  const start = session.started_at;
  const end = session.last_message_at ?? session.ended_at ?? start;
  const secs = Math.max(0, Math.floor(end - start));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
}

function titleFor(s: Session): string {
  if (s.title && s.title.trim()) return s.title;
  if (s.last_assistant_content) {
    const preview = s.last_assistant_content.trim().slice(0, 60);
    if (preview) return preview;
  }
  return s.id.split("_").slice(0, 2).join(" ");
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = lower.indexOf(q, i);
    if (hit === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (hit > i) parts.push(text.slice(i, hit));
    parts.push(
      <mark key={hit} className="search-hit">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    i = hit + q.length;
  }
  return parts;
}

interface Props {
  sessions: Session[];
  error: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  query: string;
  onLoadMore: () => void;
  totalAvailable: number;
}

export function SessionList({
  sessions,
  error,
  selectedId,
  onSelect,
  query,
  onLoadMore,
  totalAvailable,
}: Props) {
  return (
    <aside className="w-80 shrink-0 border-r border-base-300 bg-base-200/40 overflow-y-auto flex flex-col">
      {error && (
        <div className="px-3 py-2 text-2xs text-error border-b border-base-300">{error}</div>
      )}
      <ul className="flex-1">
        {sessions.map((s) => {
          const active = s.id === selectedId;
          const title = titleFor(s);
          return (
            <li key={s.id} className="border-b border-base-300/40">
              <button
                onClick={() => onSelect(s.id)}
                className={clsx(
                  "w-full flex flex-col items-start gap-0.5 py-2 px-3 text-left transition-colors",
                  active
                    ? "bg-primary/15 border-l-2 border-l-primary -ml-px pl-[10px]"
                    : "hover:bg-base-300/40 border-l-2 border-l-transparent -ml-px pl-[10px]",
                )}
              >
                <div className="flex items-center gap-2 w-full text-2xs">
                  <span
                    className={clsx(
                      "font-semibold uppercase tracking-wider",
                      SOURCE_COLOR[s.source] ?? "text-base-content/60",
                    )}
                  >
                    {s.source}
                  </span>
                  <span className="text-base-content/50">
                    {timeAgo(s.last_message_at ?? s.started_at)} ago
                  </span>
                  <span className="ml-auto text-base-content/40 font-mono">
                    {s.message_count}
                  </span>
                </div>
                <div className="text-sm truncate w-full text-base-content/90">
                  {highlight(title, query)}
                </div>
                <div className="flex gap-2 text-2xs text-base-content/40 w-full font-mono">
                  <span className="truncate">{s.model ?? "---"}</span>
                  <span>- {duration(s)}</span>
                </div>
              </button>
            </li>
          );
        })}
        {sessions.length === 0 && (
          <li className="p-6 text-center text-base-content/40 text-xs">no sessions match</li>
        )}
      </ul>
      <div className="sticky bottom-0 border-t border-base-300 bg-base-200 p-2 flex items-center justify-between text-2xs">
        <span className="text-base-content/50 font-mono">
          {sessions.length} / {totalAvailable}
        </span>
        <button className="btn btn-xs btn-ghost h-6 min-h-0" onClick={onLoadMore}>
          load more
        </button>
      </div>
    </aside>
  );
}
