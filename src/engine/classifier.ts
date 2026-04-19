/**
 * LLM-based comment intent classifier.
 *
 * Uses a fast/cheap model (haiku) with no tools to classify whether
 * a GitHub comment is requesting a code change (build/fix), an idea
 * exploration, or a lightweight action (close, label, question, etc.).
 */

export type CommentIntent =
  | "build"
  | "explore"
  | "triage"
  | "review"
  | "approve"
  | "reject"
  | "status"
  | "reset"
  | "chat";

export interface ClassificationResult {
  intent: CommentIntent;
  /** Repository mentioned in the message, if any (e.g. "cliftonc/lastlight"). */
  repo?: string;
  /** Issue or PR number mentioned, if any. */
  issueNumber?: number;
  /** Reason given for a reject intent. */
  reason?: string;
}

/** Optional surrounding context for a comment classification. */
export interface ClassifierContext {
  /** Title of the issue/PR the comment is on (when applicable). */
  issueTitle?: string;
  /** True when the comment is on a PR rather than an issue. */
  isPullRequest?: boolean;
}

const CLASSIFIER_PROMPT = `You are a router for messages directed at a GitHub/Slack bot.
Classify the user's message into exactly one category, and extract any repository or issue references.

Categories:
BUILD — The user wants code changes NOW: implement a feature, fix a bug, write code, create/send a PR, resolve an issue with code. They already know what to build.
EXPLORE — The user has a half-formed idea and wants help thinking it through BEFORE code: "help me think through X", "brainstorm Y", "spec this out", "explore an idea for Z".
TRIAGE — The user wants to scan/triage issues on a repo: "triage cliftonc/repo", "scan for new issues".
REVIEW — The user wants to review PRs on a repo: "review cliftonc/repo", "check PRs".
APPROVE — The user is approving a pending gate: "approve", "go ahead", "looks good, continue", "yes proceed".
REJECT — The user is rejecting a pending gate: "reject", "abort", "cancel this", "no don't proceed". Extract any reason given.
STATUS — The user wants to know what's running: "status", "what's running", "any tasks active?".
RESET — The user wants to start a fresh session: "new", "reset", "start over", "fresh session".
CHAT — Anything else: questions, conversation, thanks, general discussion.

When ambiguous between EXPLORE and CHAT, prefer CHAT. Only pick EXPLORE when the user is explicitly asking for brainstorming / spec-shaping / design exploration.
When ambiguous between BUILD and CHAT, prefer CHAT.
When ambiguous between APPROVE/REJECT and CHAT, prefer CHAT — only classify as APPROVE/REJECT when the intent is clearly about a pending workflow gate.

When the message is a reply on an existing issue/PR, the issue title is provided
as ISSUE TITLE. Short imperative replies like "lets build this", "build it",
"go ahead", "ship it", "do it", "implement this", "make it so" classify as
BUILD when an issue title is present — the implicit object is the issue itself.
The "prefer CHAT when ambiguous" rule does NOT apply when the comment is a
clear imperative directed at the issue's subject.

Respond in exactly this format (each on its own line, no extra text):
INTENT: BUILD|EXPLORE|TRIAGE|REVIEW|APPROVE|REJECT|STATUS|RESET|CHAT
REPO: owner/name or NONE
ISSUE: number or NONE
REASON: text or NONE

Examples:
"explore adding webhooks to cliftonc/drizby" → INTENT: EXPLORE, REPO: cliftonc/drizby, ISSUE: NONE, REASON: NONE
"build cliftonc/drizzle-cube#42" → INTENT: BUILD, REPO: cliftonc/drizzle-cube, ISSUE: 42, REASON: NONE
"lets build this!" with ISSUE TITLE "Security Review" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"go ahead" with ISSUE TITLE "Add CSV export" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"approve" → INTENT: APPROVE, REPO: NONE, ISSUE: NONE, REASON: NONE
"reject, the plan is too complex" → INTENT: REJECT, REPO: NONE, ISSUE: NONE, REASON: the plan is too complex
"what's running?" → INTENT: STATUS, REPO: NONE, ISSUE: NONE, REASON: NONE`;

/**
 * Classify a GitHub/Slack comment's intent and extract a repo reference.
 * Falls back to intent=action on any error (safe default).
 */
export async function classifyComment(
  commentBody: string,
  context?: ClassifierContext,
  model?: string,
): Promise<ClassificationResult> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const userPrompt = context?.issueTitle
      ? `Classify this comment (replying on an existing ${context.isPullRequest ? "PR" : "issue"}):\n\nISSUE TITLE: ${context.issueTitle}\n\nCOMMENT: ${commentBody}`
      : `Classify this comment:\n\n${commentBody}`;

    let output = "";
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        model: model || "claude-haiku-4-5-20251001",
        systemPrompt: CLASSIFIER_PROMPT,
        permissionMode: "bypassPermissions" as const,
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
      },
    })) {
      const m = msg as any;
      if (m.type === "result") {
        output = m.result || "";
      }
    }

    const upper = output.trim().toUpperCase();

    const intentMap: Record<string, CommentIntent> = {
      BUILD: "build",
      EXPLORE: "explore",
      TRIAGE: "triage",
      REVIEW: "review",
      APPROVE: "approve",
      REJECT: "reject",
      STATUS: "status",
      RESET: "reset",
      CHAT: "chat",
    };

    // Match INTENT line
    const intentMatch = upper.match(/INTENT:\s*(\w+)/);
    const intent: CommentIntent = intentMatch
      ? (intentMap[intentMatch[1]] ?? "chat")
      : "chat";

    // Extract repo from "REPO: owner/name" line
    const repoMatch = output.match(/REPO:\s*([\w-]+\/[\w.-]+)/i);
    const repo = repoMatch?.[1];

    // Extract issue number
    const issueMatch = output.match(/ISSUE:\s*(\d+)/i);
    const issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : undefined;

    // Extract reject reason
    const reasonMatch = output.match(/REASON:\s*(.+)/i);
    const reason = reasonMatch && reasonMatch[1].trim().toUpperCase() !== "NONE"
      ? reasonMatch[1].trim()
      : undefined;

    return { intent, repo, issueNumber, reason };
  } catch (err: any) {
    console.error(`[classifier] Error classifying comment: ${err.message}`);
    return { intent: "chat" };
  }
}
