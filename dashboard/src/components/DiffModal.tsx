import { useEffect, useMemo, useState } from "react";
import { parseDiff, Diff, Hunk, isInsert, isDelete, type FileData } from "react-diff-view";

import "react-diff-view/style/index.css";
import "./diff-theme.css";

/** +adds / -dels for one parsed file (counted from its hunk changes). */
function counts(file: FileData): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const hunk of file.hunks) {
    for (const change of hunk.changes) {
      if (isInsert(change)) adds++;
      else if (isDelete(change)) dels++;
    }
  }
  return { adds, dels };
}

/** The path to show in the file list (rename → old → new; else the live path). */
function displayPath(file: FileData): string {
  if (file.type === "rename" && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
  if (file.type === "delete") return file.oldPath;
  return file.newPath;
}

/** A short tag for the change kind, color-keyed. */
function kindBadge(type: FileData["type"]): { label: string; cls: string } | null {
  switch (type) {
    case "add":
      return { label: "new", cls: "text-success" };
    case "delete":
      return { label: "del", cls: "text-error" };
    case "rename":
      return { label: "ren", cls: "text-info" };
    default:
      return null;
  }
}

/** Full-screen overlay rendering a code-fix instance's unified diff: changed
 * files on the left, the selected file's diff (dark, syntax-styled) on the right.
 * Fetches the `changes.diff` artifact by URL (like the session/test views), then
 * parses it client-side. Closes on backdrop click or Esc — mirrors
 * {@link SessionModal}'s shell. */
export function DiffModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [patch, setPatch] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPatch(null);
    setErr(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => !cancelled && setPatch(t))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [url]);

  const files = useMemo<FileData[]>(() => {
    if (!patch) return [];
    try {
      return parseDiff(patch);
    } catch {
      return [];
    }
  }, [patch]);

  const [active, setActive] = useState(0);
  const file = files[Math.min(active, Math.max(0, files.length - 1))];

  return (
    <div className="fixed inset-0 z-50 flex bg-black/60" onClick={onClose}>
      <div
        className="m-4 flex h-[calc(100vh-2rem)] w-full max-w-none flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2.5">
          <span className="truncate font-mono text-xs text-base-content/70">{title}</span>
          {files.length > 0 && (
            <span className="shrink-0 whitespace-nowrap rounded border border-base-300 bg-base-200 px-1.5 py-0.5 font-mono text-2xs text-base-content/60">
              {files.length} file{files.length === 1 ? "" : "s"} changed
            </span>
          )}
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto whitespace-nowrap font-mono text-2xs text-info hover:underline"
          >
            raw diff
          </a>
          <button onClick={onClose} className="btn btn-ghost btn-xs h-6 min-h-0" aria-label="Close">
            ✕
          </button>
        </div>

        {err ? (
          <div className="flex-1 py-16 text-center font-mono text-sm text-error">Couldn't load diff: {err}</div>
        ) : patch === null ? (
          <div className="flex-1 py-16 text-center font-mono text-sm text-base-content/40">loading diff…</div>
        ) : files.length === 0 ? (
          <div className="flex-1 py-16 text-center font-mono text-sm text-base-content/40">
            no file changes captured
          </div>
        ) : (
          <div className="ll-diff flex min-h-0 flex-1">
            {/* Left: changed-file list */}
            <aside className="w-72 shrink-0 overflow-y-auto border-r border-base-300 bg-base-200/40 py-1.5">
              {files.map((f, i) => {
                const { adds, dels } = counts(f);
                const badge = kindBadge(f.type);
                return (
                  <button
                    key={`${f.oldPath}:${f.newPath}:${i}`}
                    onClick={() => setActive(i)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-2xs leading-4 " +
                      (i === active
                        ? "bg-base-300 text-base-content"
                        : "text-base-content/60 hover:bg-base-300/50 hover:text-base-content")
                    }
                    title={displayPath(f)}
                  >
                    <span className="min-w-0 flex-1 truncate" dir="rtl">
                      {displayPath(f)}
                    </span>
                    {badge && <span className={`shrink-0 ${badge.cls}`}>{badge.label}</span>}
                    <span className="shrink-0 tabular-nums text-success">+{adds}</span>
                    <span className="shrink-0 tabular-nums text-error">-{dels}</span>
                  </button>
                );
              })}
            </aside>

            {/* Right: the selected file's diff */}
            <div className="min-w-0 flex-1 overflow-auto bg-base-100">
              {file && (
                <div key={`${file.oldPath}:${file.newPath}:${active}`}>
                  <div className="sticky top-0 z-10 border-b border-base-300 bg-base-200/90 px-4 py-2 font-mono text-xs text-base-content/70 backdrop-blur">
                    {displayPath(file)}
                  </div>
                  <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                    {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
                  </Diff>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
