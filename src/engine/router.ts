import type { EventEnvelope } from "../connectors/types.js";

/** Skill name that should handle this event */
export type RoutingResult =
  | { action: "skill"; skill: string; context: Record<string, unknown> }
  | { action: "ignore"; reason: string };

/** Maintainer logins that can trigger builds via @mention */
const MAINTAINERS = new Set(["cliftonc"]);

/** Bot mention pattern — case-insensitive */
const BOT_MENTION = /@last-light\b/i;

/**
 * Deterministic event routing — no LLM involved.
 * Maps normalized events to the skill that should handle them.
 */
export function routeEvent(envelope: EventEnvelope): RoutingResult {
  switch (envelope.type) {
    case "issue.opened":
      return {
        action: "skill",
        skill: "issue-triage",
        context: {
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          labels: envelope.labels,
        },
      };

    case "issue.reopened":
      return {
        action: "skill",
        skill: "issue-triage",
        context: {
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          reopened: true,
        },
      };

    case "pr.opened":
      return {
        action: "skill",
        skill: "pr-review",
        context: {
          repo: envelope.repo,
          prNumber: envelope.prNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          labels: envelope.labels,
        },
      };

    case "comment.created": {
      // Only act on @last-light mentions
      if (!BOT_MENTION.test(envelope.body)) {
        return { action: "ignore", reason: "no bot mention in comment" };
      }

      // Only maintainers can trigger builds
      if (!MAINTAINERS.has(envelope.sender)) {
        return {
          action: "skill",
          skill: "polite-decline",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            sender: envelope.sender,
            body: envelope.body,
          },
        };
      }

      return {
        action: "skill",
        skill: "github-orchestrator",
        context: {
          repo: envelope.repo,
          issueNumber: envelope.issueNumber,
          title: envelope.title,
          body: envelope.body,
          sender: envelope.sender,
          commentBody: envelope.body,
        },
      };
    }

    case "pr_review.submitted":
    case "pr_review_comment.created":
      return { action: "ignore", reason: "PR review events not yet handled" };

    case "message": {
      const text = envelope.body.trim();
      const raw = envelope.raw as Record<string, unknown> | undefined;

      // Command: /new or /reset — session reset (handled by connector)
      if (text === "/new" || text === "/reset") {
        return {
          action: "skill",
          skill: "chat-reset",
          context: {
            sessionId: raw?.sessionId,
            sender: envelope.sender,
            source: envelope.source,
          },
        };
      }

      // Command: /build owner/repo#N — trigger build cycle
      const buildMatch = text.match(/^\/build\s+(.+?)(?:#(\d+))?$/i);
      if (buildMatch) {
        const repo = buildMatch[1];
        const issueNumber = buildMatch[2] ? parseInt(buildMatch[2], 10) : undefined;
        return {
          action: "skill",
          skill: "github-orchestrator",
          context: {
            repo,
            issueNumber,
            sender: envelope.sender,
            commentBody: text,
            source: envelope.source,
          },
        };
      }

      // Command: /triage owner/repo — trigger triage
      const triageMatch = text.match(/^\/triage\s+(.+)$/i);
      if (triageMatch) {
        return {
          action: "skill",
          skill: "issue-triage",
          context: {
            repo: triageMatch[1],
            sender: envelope.sender,
            source: envelope.source,
          },
        };
      }

      // Command: /review owner/repo — trigger PR review
      const reviewMatch = text.match(/^\/review\s+(.+)$/i);
      if (reviewMatch) {
        return {
          action: "skill",
          skill: "pr-review",
          context: {
            repo: reviewMatch[1],
            sender: envelope.sender,
            source: envelope.source,
          },
        };
      }

      // Command: /status — report on running tasks
      if (text === "/status") {
        return {
          action: "skill",
          skill: "status-report",
          context: {
            sender: envelope.sender,
            source: envelope.source,
          },
        };
      }

      // Default: conversational chat
      return {
        action: "skill",
        skill: "chat",
        context: {
          sessionId: raw?.sessionId,
          message: text,
          sender: envelope.sender,
          source: envelope.source,
        },
      };
    }

    default:
      return { action: "ignore", reason: `unhandled event type: ${envelope.type}` };
  }
}
