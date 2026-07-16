export type BaseMessageType =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system"
  | "meta";

export interface BaseMessage {
  id: string;
  timestamp: string;
  type: BaseMessageType;
  content: unknown;
  linkedTo?: string;
  metadata?: {
    toolName?: string;
    [k: string]: unknown;
  };
}

export interface ToolUseContent {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  tool_use_id?: string;
  content: unknown;
  is_error?: boolean;
}

export interface ToolPair {
  kind: "tool_pair";
  id: string;
  timestamp: string;
  toolName: string;
  use: BaseMessage;
  result: BaseMessage | null;
}

export interface SingleMessage {
  kind: "single";
  id: string;
  timestamp: string;
  message: BaseMessage;
}

export type TimelineItem = ToolPair | SingleMessage;

export function isToolPair(item: TimelineItem): item is ToolPair {
  return item.kind === "tool_pair";
}
export function isSingle(item: TimelineItem): item is SingleMessage {
  return item.kind === "single";
}
