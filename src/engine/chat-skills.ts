/**
 * Skill catalogue + read tool for the in-process chat path.
 *
 * Chat doesn't run inside pi-coding-agent's `AgentSession` (that class
 * is a full TUI/extension lifecycle we don't need for a one-shot Slack
 * turn). To still give chat the standard progressive-disclosure skill
 * model, we:
 *
 *  1. Load the curated chat skill list from `<repo>/skills/<name>/`
 *     at boot, using `loadSkillsFromDir` to parse the frontmatter the
 *     same way pi-coding-agent does for sandbox phases.
 *  2. Format a system-prompt XML block listing each skill's name +
 *     description (matching `formatSkillsForPrompt`'s structure but
 *     keyed by name, not absolute path, so the chat agent can ask for
 *     them by name).
 *  3. Expose a `read_skill` tool that resolves a name to that skill's
 *     SKILL.md and returns its text — same role as pi-coding-agent's
 *     built-in `read` tool when applied to a discovered SKILL.md.
 *
 * The curated list is intentionally hard-coded for v1. If chat ever
 * needs configurable skill exposure, lift this into env or settings.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { resolveSkillPaths } from "../workflows/loader.js";

/**
 * Skills exposed to chat threads. `chat` is the always-on persona;
 * the others let chat assist with one-off lookups that map to these
 * domains without delegating to a full workflow run.
 */
export const CHAT_SKILL_NAMES = [
  "chat",
  "issue-triage",
  "pr-review",
  "repo-health",
] as const;

const SKILLS_ROOT = resolve("skills");

export interface ChatSkillCatalogue {
  /** Skills the chat agent can read on demand, keyed by name. */
  skills: Skill[];
  /**
   * XML block describing each skill (name + description) suitable for
   * prepending to the chat system prompt. Empty string if no skills
   * resolved cleanly.
   */
  catalogueXml: string;
}

/**
 * Load the curated chat skill catalogue from `<repo>/skills/`.
 * Skills missing the `name`/`description` frontmatter are silently
 * dropped by `loadSkillsFromDir`, matching pi-coding-agent's behaviour.
 */
export function loadChatSkillCatalogue(): ChatSkillCatalogue {
  // loadSkillsFromDir scans the whole directory; restrict to our
  // curated set by intersecting on basename. (Skills outside CHAT_SKILL_NAMES
  // shouldn't surface to chat even if they're well-formed.)
  const { skills: all } = loadSkillsFromDir({
    dir: SKILLS_ROOT,
    source: "chat",
  });
  const wanted = new Set<string>(CHAT_SKILL_NAMES);
  const skills = all.filter((s) => wanted.has(s.name));

  if (skills.length === 0) {
    return { skills, catalogueXml: "" };
  }

  const lines: string[] = [
    "",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the `read_skill` tool with the skill `name` to load a skill's full SKILL.md when the user's task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");

  return { skills, catalogueXml: lines.join("\n") };
}

/**
 * Build the `read_skill` tool that chat uses to pull a SKILL.md on
 * demand. Returns the pi-ai `Tool` definition plus a name-keyed
 * dispatcher the chat-runner's toolset can merge into its `execute`.
 */
export interface ReadSkillToolset {
  tool: Tool;
  execute(call: ToolCall): { content: string; isError: boolean };
}

export function buildReadSkillTool(skills: Skill[]): ReadSkillToolset {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const enumNames = skills.map((s) => s.name);

  // TypeBox enum keyed by the resolved name set — gives the LLM a tight
  // schema and lets us trust the input shape after parameter validation.
  // Falls back to a plain string when no skills resolved (the tool will
  // then be a no-op, but the schema still needs to compile).
  const parameters = Type.Object({
    name: enumNames.length > 0
      ? Type.Union(
          enumNames.map((n) => Type.Literal(n)),
          { description: "The skill name from <available_skills>." },
        )
      : Type.String({ description: "The skill name from <available_skills>." }),
  });

  const tool: Tool = {
    name: "read_skill",
    description:
      "Read the full SKILL.md text for a skill listed in <available_skills>. " +
      "Use this when the user's request matches a skill's description and you need its detailed instructions.",
    parameters,
  };

  return {
    tool,
    execute(call: ToolCall) {
      const args = (call.arguments ?? {}) as { name?: unknown };
      const name = typeof args.name === "string" ? args.name : "";
      const skill = byName.get(name);
      if (!skill) {
        return {
          content: JSON.stringify({
            error: `unknown skill "${name}". Available: ${enumNames.join(", ") || "(none)"}.`,
          }),
          isError: true,
        };
      }
      try {
        // Re-resolve through the loader's allowlist + safety check rather
        // than trusting `skill.filePath` directly — same path the runner
        // uses for sandbox phases, so chat can't read arbitrary files
        // even if a future Skill loader started accepting them.
        const [dir] = resolveSkillPaths([skill.name]);
        const md = readFileSync(`${dir}/SKILL.md`, "utf-8");
        return { content: md, isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: JSON.stringify({ error: msg }), isError: true };
      }
    },
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
