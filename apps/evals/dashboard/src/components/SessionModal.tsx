import { useEffect, useState } from "react";

import { isToolPair } from "../timeline";
import type { TimelineItem as TimelineItemT } from "../timeline";
import type { TrialSession } from "../types";
import { TimelineItem } from "./timeline/TimelineItem";
import { useSessionLog } from "../lib/session";

/** Right-align user turns, matching the Last Light session viewer. */
function isUserMessage(item: TimelineItemT): boolean {
  return !isToolPair(item) && item.message.type === "user";
}

/** What the modal is showing: a single live (still-writing) transcript to follow,
 * or a finished case's per-trial / per-phase logs to browse. */
export type SessionSource =
  | { kind: "live"; title: string; url: string }
  | { kind: "trials"; title: string; sessions: TrialSession[]; baseUrl: string }
  | {
      kind: "execution";
      title: string;
      /** Run-relative-resolved URL of the captured test output, if any. */
      logUrl?: string;
      failToPass?: { id: string; pass: boolean }[];
      passToPass?: { id: string; pass: boolean }[];
    };

/** The held-out test view: per-test FAIL_TO_PASS / PASS_TO_PASS verdicts on top
 * (so you see WHICH tests failed) and the raw captured test output below. Shown
 * for resolved and unresolved code-fix cases alike. */
function ExecutionView({
  logUrl,
  failToPass = [],
  passToPass = [],
}: {
  logUrl?: string;
  failToPass?: { id: string; pass: boolean }[];
  passToPass?: { id: string; pass: boolean }[];
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!logUrl) {
      setText("");
      return;
    }
    let cancelled = false;
    fetch(logUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => !cancelled && setText(t))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [logUrl]);

  const tests = [
    ...failToPass.map((t) => ({ ...t, kind: "FAIL_TO_PASS" })),
    ...passToPass.map((t) => ({ ...t, kind: "PASS_TO_PASS" })),
  ];
  return (
    <div className="flex-1 overflow-y-auto bg-base-100">
      {tests.length > 0 && (
        <div className="space-y-1 border-b border-base-300 px-4 py-3">
          <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-base-content/40">
            held-out tests ({tests.filter((t) => t.pass).length}/{tests.length} passed)
          </div>
          {tests.map((t, i) => (
            <div key={i} className="flex items-start gap-2 font-mono text-xs leading-5">
              <span className={t.pass ? "text-success" : "text-error"}>{t.pass ? "✓" : "✗"}</span>
              <span className="shrink-0 text-base-content/40">{t.kind}</span>
              <span className="break-all text-base-content/80">{t.id}</span>
            </div>
          ))}
        </div>
      )}
      {err && <div className="px-4 py-3 font-mono text-xs text-error">Couldn't load test output: {err}</div>}
      {text === null && !err && (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">loading test output…</div>
      )}
      {text !== null && (
        <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-2xs leading-5 text-base-content/80">
          {text || "(no test output captured)"}
        </pre>
      )}
    </div>
  );
}

/** Scrolling timeline for one session jsonl URL. Re-fetches on a short interval
 * when `live`. Keyed by url upstream so switching tabs resets scroll. */
function SessionTimeline({ url, live }: { url: string; live?: boolean }) {
  const { data, isLoading, error } = useSessionLog(url, live);
  // When following live, show newest-first so fresh turns land at the top.
  const items = live ? [...(data?.items ?? [])].reverse() : data?.items ?? [];
  return (
    <div className="flex-1 space-y-2 overflow-y-auto bg-base-100 px-4 py-3">
      {error && (
        <div className="rounded-lg border border-error/40 bg-error/10 px-4 py-3 font-mono text-xs text-error">
          Couldn't load the session log: {(error as Error).message}
        </div>
      )}
      {isLoading && !data && (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">loading session…</div>
      )}
      {!isLoading && !error && items.length === 0 && (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">
          {live ? "waiting for the agent to start…" : "no messages recorded"}
        </div>
      )}
      {items.map((item) =>
        isUserMessage(item) ? (
          <div key={item.id} className="flex justify-end">
            <div className="w-fit min-w-0 max-w-[85%]">
              <TimelineItem item={item} />
            </div>
          </div>
        ) : (
          <TimelineItem key={item.id} item={item} />
        ),
      )}
    </div>
  );
}

/** Tab pill (workflow phase / trial / full), with an optional pass/fail dot. */
function Tab({
  active,
  onClick,
  label,
  ok,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  ok?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-2xs " +
        (active
          ? "border-info bg-info/15 text-info"
          : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
      }
    >
      {ok !== undefined && (
        <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (ok ? "bg-success" : "bg-error")} />
      )}
      {label}
    </button>
  );
}

/** Full-screen overlay rendering an agent session. For a finished case it shows
 * trial tabs (when `--runs N>1`) and one tab per workflow phase (plus a `full`
 * consolidated transcript); for a running case it follows the live transcript.
 * Closes on backdrop click or Esc. */
export function SessionModal({ source, onClose }: { source: SessionSource; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Trial / tab selection (trials mode only). "full" = the consolidated tab.
  const [trialIdx, setTrialIdx] = useState(0);
  const [tab, setTab] = useState<string>("0"); // phase index as string, or "full"

  const trials = source.kind === "trials" ? source.sessions : [];
  const trial = trials[Math.min(trialIdx, Math.max(0, trials.length - 1))];
  const resolve = (rel: string) =>
    source.kind === "trials" ? source.baseUrl.replace(/scorecard\.json$/, rel) : rel;

  // The currently-selected log URL + whether it's live.
  let url: string;
  let live = false;
  if (source.kind === "live") {
    url = source.url;
    live = true;
  } else if (tab === "full" && trial?.full) {
    url = resolve(trial.full);
  } else {
    const phase = trial?.phases[Number(tab)] ?? trial?.phases[0];
    url = phase ? resolve(phase.log) : trial?.full ? resolve(trial.full) : "";
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-black/60" onClick={onClose}>
      <div
        className="m-4 flex h-[calc(100vh-2rem)] w-full max-w-none flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2.5">
          {live && <span className="ll-pulse shrink-0 text-2xs font-semibold text-accent">● live</span>}
          <span className="truncate font-mono text-xs text-base-content/70">{source.title}</span>
          {live && (
            <span className="shrink-0 whitespace-nowrap rounded border border-base-300 bg-base-200 px-1.5 py-0.5 font-mono text-2xs text-base-content/60">
              ↓ newest first
            </span>
          )}
          {(() => {
            const rawUrl = source.kind === "execution" ? source.logUrl : url;
            if (!rawUrl) return null;
            return (
              <a
                href={rawUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto whitespace-nowrap font-mono text-2xs text-info hover:underline"
              >
                {source.kind === "execution" ? "raw log" : "raw jsonl"}
              </a>
            );
          })()}
          <button onClick={onClose} className="btn btn-ghost btn-xs h-6 min-h-0" aria-label="Close">
            ✕
          </button>
        </div>

        {source.kind === "trials" && (
          <div className="flex flex-col gap-2 border-b border-base-300 bg-base-200/40 px-4 py-2">
            {trials.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 font-mono text-2xs uppercase tracking-wide text-base-content/40">trial</span>
                {trials.map((t, i) => (
                  <Tab
                    key={t.trial}
                    active={i === trialIdx}
                    onClick={() => {
                      setTrialIdx(i);
                      setTab("0");
                    }}
                    label={`#${t.trial}`}
                  />
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 font-mono text-2xs uppercase tracking-wide text-base-content/40">phase</span>
              {trial?.phases.map((p, i) => (
                <Tab
                  key={`${p.phase}:${i}`}
                  active={tab === String(i)}
                  onClick={() => setTab(String(i))}
                  label={p.phase}
                  ok={p.success}
                />
              ))}
              {trial?.full && (
                <Tab active={tab === "full"} onClick={() => setTab("full")} label="full" />
              )}
            </div>
          </div>
        )}

        {source.kind === "execution" ? (
          <ExecutionView logUrl={source.logUrl} failToPass={source.failToPass} passToPass={source.passToPass} />
        ) : url ? (
          <SessionTimeline key={url} url={url} live={live} />
        ) : (
          <div className="flex-1 py-16 text-center font-mono text-sm text-base-content/40">no session log</div>
        )}
      </div>
    </div>
  );
}
