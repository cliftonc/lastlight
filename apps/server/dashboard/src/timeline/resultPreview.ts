type Summary =
  | { kind: "text"; preview: string; lines?: number; bytes: number }
  | { kind: "json"; preview: string; bytes: number; shape: string }
  | { kind: "array"; preview: string; length: number; bytes: number }
  | { kind: "empty" };

const PREVIEW_TEXT_FIELDS = [
  "output",
  "stdout",
  "text",
  "content",
  "result",
  "message",
  "error",
  "summary",
  "body",
];

const NAMING_FIELDS = [
  "title",
  "name",
  "full_name",
  "login",
  "message",
  "id",
  "number",
  "url",
  "html_url",
  "slug",
  "path",
  "summary",
];

function firstNonBlankLine(s: string): string {
  for (const line of s.split("\n")) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

function shapeOf(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  const shown = keys.slice(0, 4).join(", ");
  const rest = keys.length > 4 ? `, +${keys.length - 4}` : "";
  return `{${shown}${rest}}`;
}

function identityOf(obj: Record<string, unknown>): string | null {
  for (const field of NAMING_FIELDS) {
    const v = obj[field];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim();
      return `${field}: ${s.length > 80 ? s.slice(0, 80) + "\u2026" : s}`;
    }
    if (typeof v === "number") {
      return `${field}: ${v}`;
    }
  }
  return null;
}

function tryParseJson(s: string): unknown | undefined {
  const trimmed = s.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractNestedText(raw: unknown, depth = 0): string | null {
  if (depth > 3 || raw == null) return null;
  if (typeof raw === "string") return raw;

  if (Array.isArray(raw)) {
    const texts: string[] = [];
    for (const el of raw) {
      const t = extractNestedText(el, depth + 1);
      if (t != null) texts.push(t);
    }
    if (texts.length) return texts.join("\n");
    return null;
  }

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const field of PREVIEW_TEXT_FIELDS) {
      if (field in obj) {
        const t = extractNestedText(obj[field], depth + 1);
        if (t != null && t.trim()) return t;
      }
    }
  }
  return null;
}

export function summarizeResult(raw: unknown): Summary {
  if (raw == null || raw === "") return { kind: "empty" };

  if (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    if (parsed !== undefined) {
      const inner = summarizeResult(parsed);
      return { ...inner, bytes: raw.length } as Summary;
    }
    return {
      kind: "text",
      preview: firstNonBlankLine(raw),
      lines: raw.split("\n").length,
      bytes: raw.length,
    };
  }

  const nested = extractNestedText(raw);
  if (nested != null) {
    const bytes =
      typeof raw === "string" ? (raw as string).length : JSON.stringify(raw).length;
    const parsed = tryParseJson(nested);
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      if (Array.isArray(parsed)) {
        return {
          kind: "array",
          length: parsed.length,
          bytes,
          preview:
            parsed[0] && typeof parsed[0] === "object"
              ? identityOf(parsed[0] as Record<string, unknown>) ??
                shapeOf(parsed[0] as Record<string, unknown>)
              : String(parsed[0] ?? "").slice(0, 80),
        };
      }
      const obj = parsed as Record<string, unknown>;
      const identity = identityOf(obj);
      return {
        kind: "json",
        preview: identity ?? shapeOf(obj),
        bytes,
        shape: shapeOf(obj),
      };
    }
    return {
      kind: "text",
      preview: firstNonBlankLine(nested),
      lines: nested.split("\n").length,
      bytes,
    };
  }

  if (Array.isArray(raw)) {
    const bytes = JSON.stringify(raw).length;
    const first = raw[0];
    const preview =
      typeof first === "string"
        ? first.slice(0, 80)
        : first && typeof first === "object"
          ? shapeOf(first as Record<string, unknown>)
          : "";
    return { kind: "array", preview, length: raw.length, bytes };
  }

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const identity = identityOf(obj);
    return {
      kind: "json",
      preview: identity ?? shapeOf(obj),
      bytes: JSON.stringify(obj).length,
      shape: shapeOf(obj),
    };
  }

  return { kind: "text", preview: String(raw), bytes: String(raw).length };
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}
