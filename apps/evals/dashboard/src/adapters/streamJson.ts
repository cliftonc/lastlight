import type { Message } from "../timeline/message";

/**
 * Flatten one raw agent-session jsonl line into role-based {@link Message}s.
 *
 * The executor's event shim writes the Claude/agentic *stream-json* shape
 * (`{ type, message: { role, content: [...] }, ... }`), where tool calls live in
 * assistant `content` blocks and tool results in user `content` blocks — not the
 * flat role rows the timeline renderer expects. This is a direct port of
 * lastlight's server-side `unwrapLine` (src/session-log.ts), so the evals
 * dashboard renders the same transcript the live dashboard does, straight from
 * the archived file. One raw line can fan out to several messages (e.g. a user
 * turn carrying multiple tool_result blocks).
 */
export function unwrapLine(raw: Record<string, unknown>): Message[] {
  // Already role-based (Hermes / Agent SDK --print output).
  if (typeof raw.role === "string") return [raw as unknown as Message];

  const type = raw.type as string | undefined;
  if (!type) return [];
  if (type === "queue-operation" || type === "summary" || type === "login") return [];
  if (type === "last-prompt" || type === "attachment") return [];

  const timestamp = raw.timestamp as string | undefined;

  // The `message` field may be a JSON string or an object.
  let msg: Record<string, unknown> = {};
  if (raw.message != null) {
    if (typeof raw.message === "string") {
      try {
        msg = JSON.parse(raw.message) as Record<string, unknown>;
      } catch {
        msg = { content: raw.message };
      }
    } else if (typeof raw.message === "object") {
      msg = raw.message as Record<string, unknown>;
    }
  }

  if (type === "user") {
    const content = msg.content ?? raw.content;
    // User turns carrying tool_result blocks → one tool message per result.
    if (Array.isArray(content)) {
      const hasToolResults = content.some((b) => (b as Record<string, unknown>).type === "tool_result");
      if (hasToolResults) {
        return content
          .filter((b) => (b as Record<string, unknown>).type === "tool_result")
          .map((b) => {
            const block = b as Record<string, unknown>;
            return {
              role: "tool",
              content: block.content,
              tool_call_id: block.tool_use_id as string,
              timestamp,
            } as Message;
          });
      }
    }
    return [{ role: "user", content, timestamp } as Message];
  }

  if (type === "assistant") {
    if (raw.isApiErrorMessage || raw.error) {
      return [{ role: "system", content: String(raw.error ?? "API error"), timestamp } as Message];
    }

    const content = msg.content;
    const model = msg.model as string | undefined;
    const stopReason = msg.stop_reason as string | undefined;

    let textContent: string | undefined;
    let toolCalls: unknown[] | undefined;
    let reasoning: unknown;

    if (Array.isArray(content)) {
      const textBlocks: string[] = [];
      const tools: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textBlocks.push(b.text);
        } else if (b.type === "tool_use") {
          tools.push({ id: b.id, function: { name: b.name, arguments: b.input } });
        } else if (b.type === "thinking" || b.type === "reasoning") {
          reasoning = b.thinking ?? b.text;
        }
      }
      if (textBlocks.length) textContent = textBlocks.join("\n");
      if (tools.length) toolCalls = tools;
    } else if (typeof content === "string") {
      textContent = content;
    }

    // Drop thinking-only and completely empty assistant lines (noise).
    if (!textContent && !toolCalls) return [];

    return [
      {
        role: "assistant",
        content: textContent,
        tool_calls: toolCalls,
        reasoning,
        finish_reason: stopReason,
        model,
        timestamp,
      } as Message,
    ];
  }

  if (type === "tool_result") {
    const content = msg.content ?? raw.content;
    const toolUseId = (msg.tool_use_id as string) ?? (raw.tool_use_id as string);
    return [{ role: "tool", content, tool_call_id: toolUseId, timestamp } as Message];
  }

  if (type === "tool_use") {
    return [
      {
        role: "assistant",
        tool_calls: [{ id: msg.id ?? raw.uuid, function: { name: msg.name, arguments: msg.input } }],
        timestamp,
      } as Message,
    ];
  }

  // Skill-loading status the agent runtime emits per phase. Normally "system
  // noise", but it's the one place the transcript shows which workflow skills got
  // staged — surface it as a compact timeline chip. We keep the count + the
  // STAGED workflow skills (those bundled under `.lastlight-skills/`, as opposed
  // to the user's global `~/.agents/skills`).
  if (type === "system" && raw.subtype === "skills_status") {
    const skills = Array.isArray(raw.skills) ? (raw.skills as Array<Record<string, unknown>>) : [];
    const staged = skills
      .filter((s) => typeof s.source === "string" && (s.source as string).includes(".lastlight-skills"))
      .map((s) => String(s.name));
    return [
      {
        role: "system",
        subtype: "skills_status",
        status: typeof raw.status === "string" ? raw.status : undefined,
        discovered: typeof raw.discovered === "number" ? raw.discovered : skills.length,
        staged,
        timestamp,
      } as Message,
    ];
  }

  return [];
}
