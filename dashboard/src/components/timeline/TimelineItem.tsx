import type { TimelineItem as TimelineItemT } from "../../timeline/types";
import { isToolPair } from "../../timeline/types";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolPair } from "./ToolPair";
import { MetaMessage } from "./MetaMessage";

interface Props {
  item: TimelineItemT;
  isNew?: boolean;
}

export function TimelineItem({ item, isNew }: Props) {
  if (isToolPair(item)) return <ToolPair pair={item} isNew={isNew} />;
  const m = item.message;
  if (m.type === "user") return <UserMessage msg={m} isNew={isNew} />;
  if (m.type === "assistant") return <AssistantMessage msg={m} isNew={isNew} />;
  if (m.type === "tool_result" || m.type === "tool_use") {
    return <MetaMessage msg={m} isNew={isNew} />;
  }
  return <MetaMessage msg={m} isNew={isNew} />;
}
