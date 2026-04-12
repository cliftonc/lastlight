import type { EventEnvelope } from "../connectors/types.js";
import { classifyComment } from "./classifier.js";
import { isManagedRepo, MANAGED_REPOS } from "../managed-repos.js";
import type { StateDb } from "../state/db.js";

/** Skill name that should handle this event */
export type RoutingResult =
  | { action: "skill"; skill: string; context: Record<string, unknown> }
  | { action: "reply"; message: string }
  | { action: "ignore"; reason: string };

/** Optional dependencies the router needs to short-circuit paused runs. */
export interface RouterDeps {
  db?: StateDb;
}

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
export async function routeEvent(
  envelope: EventEnvelope,
  deps: RouterDeps = {},
): Promise<RoutingResult> {
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
      // Reply-gate short-circuit: if a paused socratic explore run is
      // waiting for any free-form message on this issue, feed the comment
      // body through without requiring an @mention or maintainer check.
      // Must sit ABOVE both the mention and role checks so plain replies
      // resume the conversation naturally.
      if (deps.db && envelope.issueNumber) {
        const triggerId = `${envelope.repo}#${envelope.issueNumber}`;
        const pendingReply = deps.db.getPendingReplyGateByTrigger(triggerId);
        if (pendingReply) {
          return {
            action: "skill",
            skill: "explore-reply",
            context: {
              repo: envelope.repo,
              issueNumber: envelope.issueNumber,
              sender: envelope.sender,
              reply: envelope.body,
              workflowRunId: pendingReply.workflowRunId,
            },
          };
        }
      }

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
      const { intent } = await classifyComment(envelope.body);
      console.log(`[router] Comment classified as: ${intent}`);

      if (envelope.prNumber) {
        // PR comments: build → pr-fix; explore is not meaningful on PRs
        // (the code already exists) so collapse it to issue-comment.
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

      // Issue comments: build → full build cycle, explore → socratic
      // explore workflow, otherwise → issue-comment.
      const issueSkill = intent === "build"
        ? "github-orchestrator"
        : intent === "explore"
        ? "explore"
        : "issue-comment";
      return {
        action: "skill",
        skill: issueSkill,
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
      const channelId = raw?.channelId as string | undefined;
      const threadId = raw?.threadId as string | undefined;
      const teamId = (raw?.team as string | undefined) || (raw?.team_id as string | undefined) || "slack";
      const slackTriggerId = channelId && threadId
        ? `slack:${teamId}:${channelId}:${threadId}`
        : undefined;

      // Reply-gate short-circuit: if a paused socratic explore run is
      // waiting on this Slack thread, feed the message body through as
      // the next reply — this must sit above all slash-command handling
      // so replies don't get mis-parsed as commands.
      if (deps.db && slackTriggerId) {
        const pendingReply = deps.db.getPendingReplyGateByTrigger(slackTriggerId);
        if (pendingReply) {
          return {
            action: "skill",
            skill: "explore-reply",
            context: {
              sender: envelope.sender,
              reply: text,
              workflowRunId: pendingReply.workflowRunId,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }
      }

      // Classify all Slack messages via the LLM classifier — no regex
      // commands. The classifier extracts intent, repo, issue number, and
      // reject reason from natural language.
      const {
        intent,
        repo: classifiedRepo,
        issueNumber: classifiedIssue,
        reason: classifiedReason,
      } = await classifyComment(text);
      console.log(
        `[router] Slack message classified as: ${intent}` +
        `${classifiedRepo ? ` (repo: ${classifiedRepo})` : ""}` +
        `${classifiedIssue ? ` (#${classifiedIssue})` : ""}`,
      );

      switch (intent) {
        case "reset":
          return {
            action: "skill",
            skill: "chat-reset",
            context: { sessionId: raw?.sessionId, sender: envelope.sender, source: envelope.source },
          };

        case "status":
          return {
            action: "skill",
            skill: "status-report",
            context: { sender: envelope.sender, source: envelope.source },
          };

        case "approve":
          return {
            action: "skill",
            skill: "approval-response",
            context: { sender: envelope.sender, decision: "approved", source: envelope.source },
          };

        case "reject":
          return {
            action: "skill",
            skill: "approval-response",
            context: {
              sender: envelope.sender,
              decision: "rejected",
              reason: classifiedReason,
              source: envelope.source,
            },
          };

        case "build": {
          if (!classifiedRepo) {
            return { action: "reply", message: "Which repo should I build against? e.g. `build cliftonc/repo#42`" };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "skill",
            skill: "github-orchestrator",
            context: {
              repo: classifiedRepo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: text,
              source: envelope.source,
            },
          };
        }

        case "triage": {
          if (!classifiedRepo) {
            return { action: "reply", message: "Which repo should I triage? e.g. `triage cliftonc/repo`" };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "skill",
            skill: "issue-triage",
            context: { repo: classifiedRepo, sender: envelope.sender, source: envelope.source },
          };
        }

        case "review": {
          if (!classifiedRepo) {
            return { action: "reply", message: "Which repo should I review PRs for? e.g. `review cliftonc/repo`" };
          }
          if (!isManagedRepo(classifiedRepo)) {
            return { action: "reply", message: unmanagedRepoReply(classifiedRepo) };
          }
          return {
            action: "skill",
            skill: "pr-review",
            context: { repo: classifiedRepo, sender: envelope.sender, source: envelope.source },
          };
        }

        case "explore": {
          if (!classifiedRepo || !isManagedRepo(classifiedRepo)) {
            return {
              action: "reply",
              message: classifiedRepo
                ? unmanagedRepoReply(classifiedRepo)
                : "I'd love to help explore that idea, but I need to know which repo to work against. " +
                  "Could you restate your request and include the repo? For example: " +
                  "\"let's explore adding webhooks to cliftonc/lastlight\"",
            };
          }
          return {
            action: "skill",
            skill: "explore",
            context: {
              repo: classifiedRepo,
              issueNumber: classifiedIssue,
              sender: envelope.sender,
              commentBody: text,
              source: envelope.source,
              triggerId: slackTriggerId,
              channelId,
              threadId,
            },
          };
        }

        default:
          // chat — conversational reply
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
    }

    default:
      return { action: "ignore", reason: `unhandled event type: ${envelope.type}` };
  }
}
