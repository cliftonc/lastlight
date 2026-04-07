/**
 * LLM-based comment intent classifier.
 *
 * Uses a fast/cheap model (haiku) with no tools to classify whether
 * a GitHub comment is requesting a code change (build/fix) or a
 * lightweight action (close, label, question, etc.).
 */

export type CommentIntent = "build" | "action";

const CLASSIFIER_PROMPT = `You are a classifier for GitHub comments directed at a bot.
Classify the user's comment into exactly one category:

BUILD — The user wants code changes: implement a feature, fix a bug, write code, create/send a PR, resolve an issue with code, address a TODO, refactor something.
ACTION — Anything else: close/reopen an issue or PR, add/remove labels, ask a question, request information, ask for status, request triage, say thanks, ask to review, etc.

Respond with exactly one word: BUILD or ACTION`;

/**
 * Classify a GitHub comment's intent using a lightweight LLM call.
 * Falls back to "action" on any error (safe default — avoids accidental builds).
 */
export async function classifyComment(
  commentBody: string,
  model?: string,
): Promise<CommentIntent> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let output = "";
    for await (const msg of query({
      prompt: `Classify this GitHub comment:\n\n${commentBody}`,
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
    if (upper.includes("BUILD")) return "build";
    return "action";
  } catch (err: any) {
    console.error(`[classifier] Error classifying comment: ${err.message}`);
    return "action"; // Safe default — don't accidentally trigger builds
  }
}
