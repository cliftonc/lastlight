import type { Span } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { safeSpanAttributes } from "./index.js";

export interface PiEventRecordOptions {
  includeContent: boolean;
  span?: Span;
  surface: "agent" | "chat";
  sessionId?: string;
  workflowName?: string;
  phaseName?: string;
  model?: string;
}

const CONTENT_LIMIT = 4096;

function trunc(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.length > CONTENT_LIMIT ? value.slice(0, CONTENT_LIMIT - 1) + "…" : value;
}

function contentTypes(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((c) => typeof c === "object" && c !== null && "type" in c ? String((c as { type?: unknown }).type) : "unknown");
}

function sanitizeMessage(message: unknown, includeContent: boolean): Record<string, unknown> {
  if (typeof message !== "object" || message === null) return {};
  const m = message as Record<string, unknown>;
  const content = Array.isArray(m.content) ? m.content : [];
  const out: Record<string, unknown> = {
    "message.role": typeof m.role === "string" ? m.role : undefined,
    "message.content_block_count": content.length,
    "message.content_block_types": contentTypes(content).join(","),
  };
  const usage = typeof m.usage === "object" && m.usage !== null ? m.usage as Record<string, unknown> : undefined;
  if (usage) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") out[`usage.${key}`] = value;
    }
  }
  if (includeContent) {
    out["message.content"] = JSON.stringify(content, (_k, v) => trunc(v));
  }
  return out;
}

export function sanitizePiEvent(record: Record<string, unknown>, includeContent = false): Record<string, unknown> {
  const type = typeof record.type === "string" ? record.type : "unknown";
  const out: Record<string, unknown> = { "pi.event_type": type };
  if (typeof record.sessionId === "string") out["agent.session_id"] = record.sessionId;
  switch (type) {
    case "session":
      if (typeof record.id === "string") out["agent.session_id"] = record.id;
      if (typeof record.cwd === "string") out["agent.cwd"] = record.cwd;
      if (typeof record.runtime === "string") out["agent.runtime"] = record.runtime;
      if (typeof record.version === "string") out["agent.version"] = record.version;
      break;
    case "message_end":
      Object.assign(out, sanitizeMessage(record.message, includeContent));
      break;
    case "tool_execution_end":
      if (typeof record.toolName === "string") out["tool.name"] = record.toolName;
      if (typeof record.tool === "string") out["tool.name"] = record.tool;
      if (typeof record.isError === "boolean") out["tool.is_error"] = record.isError;
      if (typeof record.durationMs === "number") out["tool.duration_ms"] = record.durationMs;
      if (typeof record.status === "string") out["tool.status"] = record.status;
      if (record.error instanceof Error) {
        out["error.name"] = record.error.name;
        out["error.message"] = record.error.message;
        if (includeContent) out["error.stack"] = trunc(record.error.stack);
      } else if (typeof record.error === "string") {
        out["error.message"] = record.error;
      }
      if (includeContent) {
        if (record.result !== undefined) out["tool.result"] = trunc(typeof record.result === "string" ? record.result : JSON.stringify(record.result));
        if (record.output !== undefined) out["tool.output"] = trunc(typeof record.output === "string" ? record.output : JSON.stringify(record.output));
      }
      break;
    case "extension_status":
      for (const key of ["extension", "status", "mode", "provider", "toolCount", "reason"]) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[`extension.${key}`] = value;
      }
      break;
    case "usage_snapshot":
      for (const key of ["turns", "costUsd", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) {
        const value = record[key];
        if (typeof value === "number") out[`usage.${key}`] = value;
      }
      break;
    case "fatal_error":
      if (typeof record.name === "string") out["error.name"] = record.name;
      if (typeof record.message === "string") out["error.message"] = record.message;
      if (includeContent && typeof record.stack === "string") out["error.stack"] = trunc(record.stack);
      break;
  }
  return safeSpanAttributes(out);
}

export function recordPiEvent(record: Record<string, unknown>, opts: PiEventRecordOptions): void {
  const span = opts.span ?? trace.getActiveSpan();
  if (!span) return;
  const attrs = safeSpanAttributes({
    ...sanitizePiEvent(record, opts.includeContent),
    surface: opts.surface,
    "workflow.name": opts.workflowName,
    "phase.name": opts.phaseName,
    model: opts.model,
    "agent.session_id": opts.sessionId,
  });
  span.addEvent(`pi.${typeof record.type === "string" ? record.type : "event"}`, attrs);
}
