import type { EventEnvelope } from "../connectors/types.js";
import { classifyComment } from "./classifier.js";
import { isManagedRepo, MANAGED_REPOS } from "../managed-repos.js";

/** Skill name that should handle this event */
export type RoutingResult =
  | { action: "skill"; skill: string; context: Record<string, unknown> }
  | { action: "reply"; message: string }
  | { action: "ignore"; reason: string };

/** Friendly reply when a Slack/CLI command targets an unmanaged repo. */
function unmanagedRepoReply(repo: string): string {
  return (
    `❌ I'm not configured to work on \`${repo}\`.\n` +
    `Managed repos: ${MANAGED_REPOS.map((r) => `\`${r}\``).join(", ")}.\n` +
    `Ask cliftonc to add it.`
  );
}

/** Author associations that can trigger builds via @mention */
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** Bot mention pattern — case-insensitive */
const BOT_MENTION = /@last-light\b/i;

/**
 * Event routing — deterministic for most events, LLM-classified for comments.
 * Maps normalized events to the skill that should handle them.
 */
export async function routeEvent(envelope: EventEnvelope): Promise<RoutingResult> {
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

      // Only maintainers (OWNER, MEMBER, COLLABORATOR) can trigger builds.
      // For non-maintainers we reply directly via the connector — no agent
      // invocation needed.
      if (!MAINTAINER_ROLES.has(envelope.authorAssociation || "")) {
        return {
          action: "reply",
          message:
            `Thanks for the report, @${envelope.sender}! ` +
            `I only act on requests from repository maintainers — a maintainer ` +
            `(owner / member / collaborator) needs to mention me to trigger a build.`,
        };
      }

      // Check for approval commands before LLM classification
      const approveMatch = envelope.body.match(/@last-light\s+approve\b/i);
      const rejectMatch = envelope.body.match(/@last-light\s+reject\b(.*)/i);
      if (approveMatch || rejectMatch) {
        return {
          action: "skill",
          skill: "approval-response",
          context: {
            repo: envelope.repo,
            issueNumber: envelope.issueNumber,
            sender: envelope.sender,
            decision: approveMatch ? "approved" : "rejected",
            reason: rejectMatch ? rejectMatch[1].trim() || undefined : undefined,
          },
        };
      }

      // Classify intent: is this a build/fix request or a lightweight action?
      const intent = await classifyComment(envelope.body);
      console.log(`[router] Comment classified as: ${intent}`);

      if (envelope.prNumber) {
        // PR comments: build intent → pr-fix, otherwise → issue-comment
        return {
          action: "skill",
          skill: intent === "build" ? "pr-fix" : "issue-comment",
          context: {
            repo: envelope.repo,
            prNumber: envelope.prNumber,
            issueNumber: envelope.issueNumber,
            title: envelope.title,
            body: envelope.body,
            sender: envelope.sender,
            commentBody: envelope.body,
          },
        };
      }

      // Issue comments: build intent → full build cycle, otherwise → issue-comment
      return {
        action: "skill",
        skill: intent === "build" ? "github-orchestrator" : "issue-comment",
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
        if (!isManagedRepo(repo)) {
          return { action: "reply", message: unmanagedRepoReply(repo) };
        }
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
        const repo = triageMatch[1];
        if (!isManagedRepo(repo)) {
          return { action: "reply", message: unmanagedRepoReply(repo) };
        }
        return {
          action: "skill",
          skill: "issue-triage",
          context: {
            repo,
            sender: envelope.sender,
            source: envelope.source,
          },
        };
      }

      // Command: /review owner/repo — trigger PR review
      const reviewMatch = text.match(/^\/review\s+(.+)$/i);
      if (reviewMatch) {
        const repo = reviewMatch[1];
        if (!isManagedRepo(repo)) {
          return { action: "reply", message: unmanagedRepoReply(repo) };
        }
        return {
          action: "skill",
          skill: "pr-review",
          context: {
            repo,
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

      // Command: /approve [workflow_run_id] — approve pending gate
      const approveSlash = text.match(/^\/approve(?:\s+(\S+))?$/i);
      if (approveSlash) {
        return {
          action: "skill",
          skill: "approval-response",
          context: {
            workflowRunId: approveSlash[1] || undefined,
            sender: envelope.sender,
            decision: "approved",
            source: envelope.source,
          },
        };
      }

      // Command: /reject [workflow_run_id] [reason] — reject pending gate
      const rejectSlash = text.match(/^\/reject(?:\s+(\S+))?(?:\s+(.+))?$/i);
      if (rejectSlash) {
        return {
          action: "skill",
          skill: "approval-response",
          context: {
            workflowRunId: rejectSlash[1] || undefined,
            sender: envelope.sender,
            decision: "rejected",
            reason: rejectSlash[2] || undefined,
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
