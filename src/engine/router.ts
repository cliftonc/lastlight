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

    case "message":
      // Future: Slack/Discord messages → create GitHub issue → orchestrate
      return { action: "ignore", reason: "chat messages not yet handled" };

    default:
      return { action: "ignore", reason: `unhandled event type: ${envelope.type}` };
  }
}
