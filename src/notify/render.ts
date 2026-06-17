/**
 * The single shared renderer. Turns a {@link ProgressModel} into markdown.
 * GitHub posts the output as-is; the Slack transport converts it via
 * `markdownToSlackMrkdwn` first. There is exactly one renderer so the two
 * platforms can never drift in content.
 */
import type { ProgressModel, StepStatus } from "./types.js";

/** Status → leading emoji. Ported from the Mastra rebuild's EMOJI map. */
export const STATUS_EMOJI: Record<StepStatus, string> = {
  pending: "⬜",
  running: "🔄",
  done: "✅",
  blocked: "⛔",
  awaiting: "⏸️",
  failed: "❌",
  skipped: "➖",
};

/** Render the model to a single markdown body. */
export function renderProgress(model: ProgressModel): string {
  const lines: string[] = [];

  lines.push(`### 🤖 ${model.title}`);
  if (model.subtitle) {
    lines.push("");
    lines.push(`**${model.subtitle}**`);
  }
  if (model.meta && model.meta.length > 0) {
    lines.push("");
    for (const m of model.meta) if (m.trim()) lines.push(m);
  }

  lines.push("");
  for (const step of model.steps) {
    const emoji = STATUS_EMOJI[step.status] ?? STATUS_EMOJI.pending;
    const detail = step.detail ? ` — ${step.detail}` : "";
    lines.push(`- ${emoji} **${step.label}**${detail}`);
  }

  if (model.footer && model.footer.trim()) {
    lines.push("");
    lines.push(model.footer);
  }

  return lines.join("\n");
}
