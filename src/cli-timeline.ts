/**
 * CLI rendering of a session transcript — a terminal port of the dashboard's
 * timeline (dashboard/src/timeline/*). It pairs each assistant tool call with
 * its result, summarizes the result to one line (the same heuristics the
 * dashboard uses), and prints assistant/user prose plainly. `full` expands the
 * truncations and dumps the full tool-result text.
 */
import chalk from "chalk";
import Table from "cli-table3";

// ── tool family classification (port of timeline/toolFamily.ts) ──────────────
export type ToolFamily = "shell" | "fs" | "git" | "web" | "plan" | "mcp" | "other";

const FAMILY_BY_NAME: Record<string, ToolFamily> = {
  terminal: "shell", bash: "shell", shell: "shell",
  read_file: "fs", write_file: "fs", edit_file: "fs", list_files: "fs", search_files: "fs",
  read: "fs", write: "fs", edit: "fs", grep: "fs", glob: "fs",
  web_fetch: "web", web_search: "web", webfetch: "web", websearch: "web",
  todo: "plan", todowrite: "plan", task: "plan", skill_view: "plan",
};
const GIT_NAME_HINTS = ["commit", "branch", "repo", "repository", "pull_request", "pr_", "issue", "comment", "push", "clone", "merge", "tag", "release"];

export function classifyTool(name: string): ToolFamily {
  const l = name.toLowerCase();
  if (FAMILY_BY_NAME[l]) return FAMILY_BY_NAME[l];
  if (l.startsWith("mcp_github_") || l.startsWith("github_")) return "git";
  if (l.startsWith("mcp_")) return GIT_NAME_HINTS.some((h) => l.includes(h)) ? "git" : "mcp";
  return "other";
}

const FAMILY_STYLE: Record<ToolFamily, { glyph: string; color: (s: string) => string }> = {
  shell: { glyph: "$", color: chalk.blue },
  fs: { glyph: "▤", color: chalk.cyan },
  git: { glyph: "⎇", color: chalk.yellow },
  web: { glyph: "⊕", color: chalk.magenta },
  plan: { glyph: "☰", color: chalk.green },
  mcp: { glyph: "⚙", color: chalk.greenBright },
  other: { glyph: "•", color: chalk.gray },
};

export function formatToolName(name: string): string {
  const l = name.toLowerCase();
  // Drop the github_ / mcp_github_ prefix — the git glyph already signals it,
  // and the bare action keeps the label inside the fixed gutter.
  if (l.startsWith("mcp_github_")) return name.slice(11);
  if (l.startsWith("github_")) return name.slice(7);
  if (l.startsWith("mcp_")) {
    const parts = name.slice(4).split("_");
    if (parts.length >= 2) return `${parts[0]}.${parts.slice(1).join("_")}`;
  }
  return name;
}

// ── arg summary (text port of timeline/toolRenderers.tsx) ────────────────────
function str(v: unknown): string { return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v); }
function trunc(s: string, max: number): string { return s.length <= max ? s : s.slice(0, max) + "…"; }
function shortPath(p: string): string {
  if (p.length < 50) return p;
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}

export function renderArgs(name: string, input: any): string {
  const i = input ?? {};
  switch (name.toLowerCase()) {
    case "terminal": case "bash": return trunc(str(i.command), 140);
    case "read_file": case "read": {
      const p = shortPath(str(i.path ?? i.file_path));
      const off = i.offset ?? i.line_start;
      return off != null ? `${p} L${off}${(i.limit ?? i.line_end) != null ? "-" + (i.limit ?? i.line_end) : ""}` : p;
    }
    case "write_file": case "write": {
      const p = shortPath(str(i.path ?? i.file_path));
      const lines = str(i.content) ? str(i.content).split("\n").length : 0;
      return lines ? `${p} (${lines} lines)` : p;
    }
    case "edit_file": case "edit":
      return shortPath(str(i.path ?? i.file_path)) + (i.replace_all === true ? " [replace_all]" : "");
    case "search_files": case "grep":
      return `/${trunc(str(i.pattern), 60)}/` + (i.path ? ` in ${shortPath(str(i.path))}` : "");
    case "glob": return str(i.pattern);
    case "list_files": return shortPath(str(i.path ?? "."));
    case "web_fetch": case "webfetch": return str(i.url);
    case "web_search": case "websearch": return trunc(str(i.query), 120);
    case "todo": case "todowrite": return `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
    case "skill_view": return str(i.name);
    case "task": return `${str(i.subagent_type) || "agent"}: ${trunc(str(i.description) || str(i.prompt), 100)}`;
  }
  const entries = Object.entries(i).slice(0, 3);
  return entries.map(([k, v]) => `${k}: ${trunc(str(v), 50)}`).join("  ");
}

// ── result summarization (port of timeline/resultPreview.ts) ─────────────────
type Summary =
  | { kind: "text"; preview: string; lines?: number; bytes: number }
  | { kind: "json"; preview: string; bytes: number; shape: string }
  | { kind: "array"; preview: string; length: number; bytes: number }
  | { kind: "empty" };

const PREVIEW_TEXT_FIELDS = ["output", "stdout", "text", "content", "result", "message", "error", "summary", "body"];
const NAMING_FIELDS = ["title", "name", "full_name", "login", "message", "id", "number", "url", "html_url", "slug", "path", "summary"];

function firstNonBlankLine(s: string): string {
  for (const line of s.split("\n")) if (line.trim().length > 0) return line.trim();
  return "";
}
function shapeOf(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "{}";
  return `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? `, +${keys.length - 4}` : ""}}`;
}
function identityOf(obj: Record<string, unknown>): string | null {
  for (const field of NAMING_FIELDS) {
    const v = obj[field];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim();
      return `${field}: ${s.length > 80 ? s.slice(0, 80) + "…" : s}`;
    }
    if (typeof v === "number") return `${field}: ${v}`;
  }
  return null;
}
function tryParseJson(s: string): unknown | undefined {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}
function extractNestedText(raw: unknown, depth = 0): string | null {
  if (depth > 3 || raw == null) return null;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const texts: string[] = [];
    for (const el of raw) { const t = extractNestedText(el, depth + 1); if (t != null) texts.push(t); }
    return texts.length ? texts.join("\n") : null;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const field of PREVIEW_TEXT_FIELDS) {
      if (field in obj) { const t = extractNestedText(obj[field], depth + 1); if (t != null && t.trim()) return t; }
    }
  }
  return null;
}

export function summarizeResult(raw: unknown): Summary {
  if (raw == null || raw === "") return { kind: "empty" };
  if (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    if (parsed !== undefined) return { ...summarizeResult(parsed), bytes: raw.length } as Summary;
    return { kind: "text", preview: firstNonBlankLine(raw), lines: raw.split("\n").length, bytes: raw.length };
  }
  const nested = extractNestedText(raw);
  if (nested != null) {
    const bytes = JSON.stringify(raw).length;
    const parsed = tryParseJson(nested);
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      if (Array.isArray(parsed)) {
        return {
          kind: "array", length: parsed.length, bytes,
          preview: parsed[0] && typeof parsed[0] === "object"
            ? identityOf(parsed[0] as Record<string, unknown>) ?? shapeOf(parsed[0] as Record<string, unknown>)
            : String(parsed[0] ?? "").slice(0, 80),
        };
      }
      const obj = parsed as Record<string, unknown>;
      return { kind: "json", preview: identityOf(obj) ?? shapeOf(obj), bytes, shape: shapeOf(obj) };
    }
    return { kind: "text", preview: firstNonBlankLine(nested), lines: nested.split("\n").length, bytes };
  }
  if (Array.isArray(raw)) {
    const first = raw[0];
    return {
      kind: "array", length: raw.length, bytes: JSON.stringify(raw).length,
      preview: typeof first === "string" ? first.slice(0, 80)
        : first && typeof first === "object" ? shapeOf(first as Record<string, unknown>) : "",
    };
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    return { kind: "json", preview: identityOf(obj) ?? shapeOf(obj), bytes: JSON.stringify(obj).length, shape: shapeOf(obj) };
  }
  return { kind: "text", preview: String(raw), bytes: String(raw).length };
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}

/** The full human text of a result (nested text if present, else pretty JSON) — used by --full. */
function resultFullText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    const parsed = tryParseJson(raw);
    return parsed !== undefined ? (extractNestedText(parsed) ?? JSON.stringify(parsed, null, 2)) : raw;
  }
  return extractNestedText(raw) ?? JSON.stringify(raw, null, 2);
}

// ── rendering ────────────────────────────────────────────────────────────────
function plainText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b: any) =>
      typeof b === "string" ? b : b && typeof b === "object" && typeof b.text === "string" ? b.text : "",
    ).filter(Boolean).join("\n");
  }
  return String(content);
}

function isErrorResult(content: unknown): boolean {
  return Boolean(content && typeof content === "object" && (content as any).is_error === true);
}

const ROLE_LABEL: Record<string, (s: string) => string> = {
  user: chalk.green, assistant: chalk.cyan, system: chalk.yellow,
};

const LABEL_WIDTH = 22; // fixed left column; tool labels are pre-truncated to fit

interface Row { label: string; content: string; labelRight?: boolean }

function fitLabel(plain: string): string {
  return plain.length <= LABEL_WIDTH ? plain : plain.slice(0, LABEL_WIDTH - 1) + "…";
}

function pushProse(rows: Row[], role: string, text: string): void {
  if (!text.trim()) return;
  const max = 1200;
  const body = text.length > max ? text.slice(0, max) + chalk.dim(` … (+${text.length - max} chars; --full)`) : text;
  rows.push({ label: (ROLE_LABEL[role] ?? chalk.dim)(role), content: body });
}

function pushToolPair(rows: Row[], name: string, args: unknown, result: any): void {
  const st = FAMILY_STYLE[classifyTool(name)];
  const argStr = args !== undefined ? renderArgs(name, args) : "";
  rows.push({ label: st.color(fitLabel(`${st.glyph} ${formatToolName(name)}`)), content: chalk.dim(argStr) });
  if (!result) return;
  const content = result.content;
  const s = summarizeResult(content);
  const err = isErrorResult(content);
  const marker = (err ? chalk.red : chalk.dim)("└");
  if (s.kind === "empty") { rows.push({ label: marker, content: chalk.dim("(empty)"), labelRight: true }); return; }
  const meta: string[] = [];
  if (s.kind === "text" && s.lines && s.lines > 1) meta.push(`${s.lines} lines`);
  if (s.kind === "array") meta.push(`${s.length} items`);
  meta.push(formatBytes(s.bytes));
  const metaStr = chalk.dim(`(${meta.join(", ")})`);
  const value = err ? chalk.red(s.preview) : s.preview;
  rows.push({ label: marker, content: `${value} ${metaStr}`, labelRight: true });
}

/** Render accumulated rows as a borderless, word-wrapped two-column table. */
function renderRows(rows: Row[]): string[] {
  if (rows.length === 0) return [];
  const cols = process.stdout.columns || 100;
  const contentWidth = Math.max(40, cols - LABEL_WIDTH - 4);
  const table = new Table({
    chars: {
      top: "", "top-mid": "", "top-left": "", "top-right": "",
      bottom: "", "bottom-mid": "", "bottom-left": "", "bottom-right": "",
      left: "", "left-mid": "", mid: "", "mid-mid": "", right: "", "right-mid": "",
      middle: "  ",
    },
    style: { "padding-left": 0, "padding-right": 0, head: [], border: [] },
    colWidths: [LABEL_WIDTH, contentWidth],
    wordWrap: true,
    // Char-wrap, not word-boundary: a single token longer than the column
    // (a base64 blob, a long JSON line) makes word-boundary wrapping spin.
    wrapOnWordBoundary: false,
  });
  for (const r of rows) {
    table.push([{ content: r.label, hAlign: r.labelRight ? "right" : "left" }, r.content]);
  }
  // cli-table3 pads every cell to its column width — trim the trailing
  // whitespace it leaves on each line (there's no right border to align to).
  return table.toString().split("\n").map((l) => l.replace(/\s+$/, ""));
}

function buildRows(messages: any[]): Row[] {
  const rows: Row[] = [];
  const resultByCallId = new Map<string, any>();
  for (const m of messages) {
    if ((m.role ?? m.type) === "tool" && m.tool_call_id) resultByCallId.set(m.tool_call_id, m);
  }
  const used = new Set<string>();
  for (const m of messages) {
    const role = m.role ?? m.type;
    if (role === "assistant") {
      pushProse(rows, "assistant", plainText(m.content));
      for (const call of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        const fn = (call && call.function) || call || {};
        const name = fn.name ?? call?.name ?? "tool";
        const result = call?.id ? resultByCallId.get(call.id) : undefined;
        if (call?.id && result) used.add(call.id);
        pushToolPair(rows, name, fn.arguments ?? call?.arguments ?? call?.input, result);
      }
    } else if (role === "tool") {
      if (m.tool_call_id && used.has(m.tool_call_id)) continue; // already shown with its call
      pushToolPair(rows, m.tool_name ?? "tool", undefined, m);
    } else if (role === "user" || role === "system") {
      pushProse(rows, role, plainText(m.content));
    }
  }
  return rows;
}

/** Render the transcript: tool calls paired to results, summarized one-liners. */
export function renderTimeline(messages: any[]): string[] {
  return renderRows(buildRows(messages));
}

/** Render a single message (no cross-message pairing) — used by `--follow`. */
export function renderMessage(msg: any): string[] {
  return renderRows(buildRows([msg]));
}

/**
 * Raw, unformatted dump of the whole transcript (`--full`) — no table, no
 * summarization, no truncation. A header line per message, then the full text
 * content (tool results unwrapped from their MCP envelope to readable text).
 */
export function renderRaw(messages: any[]): string[] {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role ?? m.type;
    if (role === "assistant") {
      const text = plainText(m.content);
      if (text.trim()) { lines.push(chalk.cyan("── assistant ──")); lines.push(text, ""); }
      for (const call of (Array.isArray(m.tool_calls) ? m.tool_calls : [])) {
        const fn = (call && call.function) || call || {};
        lines.push(chalk.blue(`── tool: ${fn.name ?? call?.name ?? "tool"} ──`));
        lines.push(JSON.stringify(fn.arguments ?? call?.arguments ?? call?.input ?? {}, null, 2), "");
      }
    } else if (role === "tool") {
      lines.push(chalk.magenta(`── result${m.tool_call_id ? ` (${m.tool_call_id})` : ""} ──`));
      lines.push(resultFullText(m.content), "");
    } else if (role === "user" || role === "system") {
      const text = plainText(m.content);
      if (text.trim()) { lines.push((ROLE_LABEL[role] ?? chalk.dim)(`── ${role} ──`)); lines.push(text, ""); }
    }
  }
  return lines;
}
