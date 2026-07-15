import type {
  BaseMessage,
  TimelineItem,
  ToolUseContent,
  ToolResultContent,
} from "./types";

function extractToolUseId(msg: BaseMessage): string | null {
  const c = msg.content as ToolUseContent | undefined;
  return (c && typeof c.id === "string" ? c.id : null) ?? null;
}

function extractToolUseName(msg: BaseMessage): string {
  const c = msg.content as ToolUseContent | undefined;
  return (c && typeof c.name === "string" && c.name) || "tool";
}

function extractToolResultId(msg: BaseMessage): string | null {
  if (msg.linkedTo) return msg.linkedTo;
  const c = msg.content as ToolResultContent | undefined;
  return (c && typeof c.tool_use_id === "string" ? c.tool_use_id : null) ?? null;
}

export function processMessages(messages: BaseMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const used = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i]!;
    if (used.has(current.id)) continue;

    if (current.type === "tool_use") {
      const useId = extractToolUseId(current);
      let resultIdx = -1;
      if (useId) {
        for (let j = i + 1; j < messages.length; j++) {
          const m = messages[j]!;
          if (used.has(m.id)) continue;
          if (m.type !== "tool_result") continue;
          if (extractToolResultId(m) === useId) {
            resultIdx = j;
            break;
          }
        }
      }
      const result = resultIdx >= 0 ? messages[resultIdx]! : null;
      items.push({
        kind: "tool_pair",
        id: `pair-${current.id}`,
        timestamp: current.timestamp,
        toolName:
          (result?.metadata?.toolName as string | undefined) ??
          extractToolUseName(current),
        use: current,
        result,
      });
      used.add(current.id);
      if (result) used.add(result.id);
      continue;
    }

    items.push({
      kind: "single",
      id: current.id,
      timestamp: current.timestamp,
      message: current,
    });
  }

  return items;
}
