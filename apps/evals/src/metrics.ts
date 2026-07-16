/**
 * Pull per-run token/cost/turn metrics out of the session jsonl the event
 * shim writes (`src/engine/event-shim.ts`). Each phase emits one `result`
 * envelope carrying `total_cost_usd` / `total_input_tokens` /
 * `total_output_tokens` (plus `total_cache_read_input_tokens` /
 * `total_cache_creation_input_tokens`, which we sum into `cachedTokens` —
 * Anthropic bills most of its prompt as cached, so omitting it made input
 * collapse to ~zero). We sum them across every jsonl under the run's sessions
 * dir. Best-effort: missing files / lines just contribute zero.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RunMetrics {
  inputTokens: number;
  /** Cached prompt tokens (Anthropic cache read + creation). Reported as its
   * own total so providers that bill cached input separately (and far cheaper)
   * are comparable — folding it into `inputTokens` would hide the split and,
   * for OpenAI-style usage where cached is a subset of input, double-count. */
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * The in-process executor flushes its FINAL session envelope (the `result`
 * line that carries cost/tokens) fire-and-forget (`void shim.flush()`), so it
 * can land just after `runWorkflow` resolves. Wait for the jsonl tree to stop
 * growing before reading metrics, so we don't miss it (and don't delete the
 * workspace out from under the pending write).
 */
export async function drainSessions(sessionsDir: string, maxMs = 4000, quietMs = 250): Promise<void> {
  const sizeOf = (): number => {
    const files: string[] = [];
    walkJsonl(join(sessionsDir, "projects"), files);
    return files.reduce((sum, f) => {
      try {
        return sum + statSync(f).size;
      } catch {
        return sum;
      }
    }, 0);
  };
  const deadline = Date.now() + maxMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const cur = sizeOf();
    if (cur > 0 && cur === last) {
      if (Date.now() - stableSince >= quietMs) return;
    } else {
      last = cur;
      stableSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** One session jsonl file the shim wrote (`projects/<slug>/<sessionId>.jsonl`),
 * with the timestamp of its first line — used to bucket each session into the
 * workflow phase whose window it falls in. */
export interface SessionFileInfo {
  file: string;
  /** ms epoch of the first line's `timestamp` (0 if none parseable). */
  firstTs: number;
}

/** Enumerate the run's session jsonl files (one per sessionId / phase / sub-agent
 * run), each with its first-line timestamp, sorted chronologically. The harness
 * maps these to workflow phases by start-time window (see run-instance). */
export function listSessionFiles(sessionsDir: string): SessionFileInfo[] {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  walkJsonl(sessionsDir, files);
  const seen = new Set<string>();
  const out: SessionFileInfo[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    let firstTs = 0;
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as { timestamp?: string | number };
          if (o.timestamp != null) {
            firstTs = typeof o.timestamp === "number" ? o.timestamp * 1000 : Date.parse(o.timestamp);
            break;
          }
        } catch {
          /* keep scanning */
        }
      }
    } catch {
      /* unreadable — leave firstTs 0 */
    }
    out.push({ file, firstTs });
  }
  return out.sort((a, b) => a.firstTs - b.firstTs);
}

/** Concatenate the given jsonl files (already in order) into one raw jsonl
 * string. Best-effort: an unreadable file contributes nothing. */
export function concatJsonl(files: string[]): string {
  const chunks: string[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(f, "utf8").trim();
      if (text) chunks.push(text);
    } catch {
      /* skip */
    }
  }
  return chunks.length ? chunks.join("\n") + "\n" : "";
}

/**
 * Concatenate every session jsonl under a run's sessions dir into one raw jsonl
 * string (stable phase order by path, de-duplicated), for archiving alongside
 * the run + later rendering in the dashboard. Each run uses a fresh temp
 * `stateDir`, so all jsonl under it belong to that one instance — no slug
 * matching needed (the same set `collectMetrics` reads). Best-effort: an
 * unreadable file just contributes nothing.
 */
export function readSessionLog(sessionsDir: string): string {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  walkJsonl(sessionsDir, files);
  const seen = new Set<string>();
  const chunks: string[] = [];
  for (const file of [...files].sort()) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) chunks.push(text);
    } catch {
      /* best-effort */
    }
  }
  return chunks.length ? chunks.join("\n") + "\n" : "";
}

function walkJsonl(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walkJsonl(full, out);
    else if (name.name.endsWith(".jsonl")) out.push(full);
  }
}

export function collectMetrics(sessionsDir: string): RunMetrics {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  // Fallback: some shim configs write directly under sessionsDir.
  walkJsonl(sessionsDir, files);

  const seen = new Set<string>();
  const metrics: RunMetrics = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim() || !line.includes('"result"')) continue;
      try {
        const env = JSON.parse(line) as {
          type?: string;
          total_input_tokens?: number;
          total_cache_read_input_tokens?: number;
          total_cache_creation_input_tokens?: number;
          total_output_tokens?: number;
          total_cost_usd?: number;
        };
        if (env.type !== "result") continue;
        metrics.inputTokens += env.total_input_tokens ?? 0;
        metrics.cachedTokens +=
          (env.total_cache_read_input_tokens ?? 0) + (env.total_cache_creation_input_tokens ?? 0);
        metrics.outputTokens += env.total_output_tokens ?? 0;
        metrics.costUsd += env.total_cost_usd ?? 0;
      } catch {
        /* ignore malformed lines */
      }
    }
  }
  return metrics;
}
