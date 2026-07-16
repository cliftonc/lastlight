import { useQuery } from "@tanstack/react-query";

import { toBaseMessages } from "../adapters/lastlightToTimeline";
import { unwrapLine } from "../adapters/streamJson";
import { processMessages } from "../timeline";
import type { TimelineItem as TimelineItemT } from "../timeline";
import type { Message } from "../timeline/message";

/**
 * Load an archived agent session jsonl (written per case under a run's
 * `sessions/` dir) and turn it into a timeline the renderer can draw. Unlike the
 * Last Light dashboard's live `EventSource` stream, this is a one-shot fetch of a
 * static file served by the harness's `/data/*` route — so we parse the whole
 * file once. The raw lines are the agentic *stream-json* shape, so each is first
 * flattened via {@link unwrapLine} (which also drops the `result` metrics
 * envelope and system noise), then fed through the same adapter + processor. A
 * live file's trailing line may be half-written, so a parse failure is skipped.
 */
async function fetchSessionItems(url: string): Promise<{ items: TimelineItemT[]; messageCount: number }> {
  const res = await fetch(url, { headers: { accept: "application/x-ndjson, text/plain" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const text = await res.text();
  const messages: Message[] = [];
  let id = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      for (const m of unwrapLine(raw)) {
        m.id = id++; // stable, unique key for the renderer (raw lines carry none)
        messages.push(m);
      }
    } catch {
      /* skip a malformed / half-written line */
    }
  }
  return { items: processMessages(toBaseMessages(messages)), messageCount: messages.length };
}

/** TanStack-Query hook for one session jsonl. A finished log never changes, so
 * it's cached indefinitely; a `live` log (a still-running case) is re-fetched on
 * a short interval so the modal can be followed along as the agent works. */
export function useSessionLog(url: string | undefined, live = false) {
  return useQuery({
    queryKey: ["session-log", url, live],
    queryFn: () => fetchSessionItems(url as string),
    enabled: !!url,
    staleTime: live ? 0 : Infinity,
    refetchInterval: live ? 1500 : false,
    placeholderData: (prev) => prev,
  });
}
