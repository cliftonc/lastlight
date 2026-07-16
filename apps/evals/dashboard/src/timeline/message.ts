/**
 * One raw line of an agent session jsonl, as the executor's event shim writes
 * it. Ported from the Last Light dashboard's `api.ts` so the timeline renderer
 * is self-contained here (the evals dashboard reads a static archived jsonl,
 * not the live `/admin/api/sessions` stream).
 */
export interface Message {
  /** Assigned by the loader (a running counter) — raw stream-json lines and
   * freshly-unwrapped messages carry none until then. */
  id?: number;
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: string | number;
  reasoning?: unknown;
  finish_reason?: string;
  [k: string]: unknown;
}
