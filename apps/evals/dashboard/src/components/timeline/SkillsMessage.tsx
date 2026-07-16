import { Puzzle } from "lucide-react";
import type { BaseMessage } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";

interface SkillsContent {
  kind: "skills";
  status?: string;
  discovered?: number;
  staged?: string[];
}

/**
 * Compact chip for an agent `skills_status` event — the per-phase signal of
 * which skills the runtime loaded. Highlights the STAGED workflow skills (the
 * `.lastlight-skills/` bundle for that phase, e.g. `building`, `code-review`);
 * falls back to a muted "N available" when only the global skill set is present.
 */
export function SkillsMessage({ msg, isNew }: { msg: BaseMessage; isNew?: boolean }) {
  const c = msg.content as SkillsContent;
  const staged = c.staged ?? [];
  const hasStaged = staged.length > 0;

  return (
    <MessageCard
      isNew={isNew}
      timestamp={msg.timestamp}
      dense
      title={
        <>
          <RowIcon
            Icon={Puzzle}
            color={hasStaged ? "text-accent" : "text-base-content/50"}
            bg={hasStaged ? "bg-accent/10" : "bg-base-content/10"}
          />
          <span className="shrink-0 text-2xs font-semibold uppercase tracking-wider text-base-content/60">
            skills
          </span>
          {c.status && (
            <span className="shrink-0 text-2xs text-base-content/40">{c.status}</span>
          )}
          {hasStaged ? (
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {staged.map((name) => (
                <span
                  key={name}
                  className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs text-accent"
                >
                  {name}
                </span>
              ))}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-2xs text-base-content/40">
              {c.discovered != null ? `${c.discovered} available` : ""}
            </span>
          )}
          {hasStaged && c.discovered != null && (
            <span className="shrink-0 text-2xs text-base-content/30">{c.discovered} available</span>
          )}
        </>
      }
    />
  );
}
