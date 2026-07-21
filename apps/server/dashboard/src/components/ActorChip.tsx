import { useState } from "react";
import {
  UserCircleIcon,
  ChatBubbleLeftRightIcon,
  CommandLineIcon,
  ClockIcon,
  ShieldCheckIcon,
  CpuChipIcon,
} from "@heroicons/react/24/outline";
import { GhLink } from "./GhLink";
import type { WorkflowRun, TriggeredByUser } from "../api";

type ActorType = NonNullable<WorkflowRun["triggerActorType"]>;

/** Per-actor-type fallback icon (used when there's no avatar), + a tooltip label. */
const ACTOR_META: Record<ActorType, { Icon: typeof UserCircleIcon; label: string }> = {
  github: { Icon: UserCircleIcon, label: "GitHub" },
  slack: { Icon: ChatBubbleLeftRightIcon, label: "Slack" },
  cli: { Icon: CommandLineIcon, label: "CLI / API" },
  cron: { Icon: ClockIcon, label: "Cron" },
  admin: { Icon: ShieldCheckIcon, label: "Admin" },
  system: { Icon: CpuChipIcon, label: "System" },
};

export interface ActorChipProps {
  /** The raw actor handle (`workflow_runs.triggered_by`). */
  login?: string;
  /** Coarse actor category — drives the fallback icon + tooltip. */
  actorType?: ActorType;
  /** `users`-table enrichment (avatar + real name), when resolved. */
  user?: TriggeredByUser | null;
  /** `sm` (default) for list rows, `md` for the detail panel. */
  size?: "sm" | "md";
  className?: string;
}

/**
 * Renders "who triggered this" (issue #205) as an icon/avatar + name chip. Uses
 * the `users`-table avatar + real name when available, else the actor handle,
 * else the actor-type label; falls back to a per-type icon when there's no
 * avatar. GitHub actors link out to their profile.
 */
export function ActorChip({ login, actorType, user, size = "sm", className }: ActorChipProps) {
  const [imgFailed, setImgFailed] = useState(false);

  // Nothing to show at all — omit the chip entirely.
  const display = user?.name || user?.login || login;
  if (!display && !actorType) return null;

  const meta = actorType ? ACTOR_META[actorType] : undefined;
  const Icon = meta?.Icon ?? UserCircleIcon;
  const dim = size === "md" ? "w-5 h-5" : "w-4 h-4";
  const textCls = size === "md" ? "text-xs" : "text-2xs";
  const avatarUrl = user?.avatarUrl && !imgFailed ? user.avatarUrl : null;

  const glyph = avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      className={`${dim} rounded-full shrink-0 object-cover`}
      onError={() => setImgFailed(true)}
    />
  ) : (
    <Icon className={`${dim} shrink-0 text-base-content/50`} />
  );

  const label = display ?? meta?.label ?? "";
  const title = `Triggered by ${label}${meta ? ` (${meta.label})` : ""}`;

  // GitHub actors with a login link out to their profile; everything else is
  // plain text (Slack ids / cli / cron aren't GitHub-resolvable).
  const body =
    actorType === "github" && login ? (
      <GhLink
        href={`https://github.com/${encodeURIComponent(login)}`}
        className={`${textCls} font-mono hover:underline truncate`}
        title={title}
      >
        {label}
      </GhLink>
    ) : (
      <span className={`${textCls} font-mono text-base-content/70 truncate`} title={title}>
        {label}
      </span>
    );

  return (
    <span className={`inline-flex items-center gap-1 min-w-0 ${className ?? ""}`} title={title}>
      {glyph}
      {body}
    </span>
  );
}
