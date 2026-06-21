import { describe, it, expect } from "vitest";
import { CHAT_SYSTEM_SUFFIX } from "./chat.js";

describe("CHAT_SYSTEM_SUFFIX", () => {
  it("contains no backtick-quoted slash-command tokens", () => {
    // Regression guard for #119: the chat prompt must not advertise
    // leading-slash "commands" (Slack intercepts `/...` before it reaches
    // the bot). Scan for backtick + slash + word char.
    const slashTokenPattern = /`\/\w+/g;
    const matches = CHAT_SYSTEM_SUFFIX.match(slashTokenPattern) ?? [];
    expect(matches).toEqual([]);
  });

  it("uses natural-language phrasings for the core intents", () => {
    expect(CHAT_SYSTEM_SUFFIX).toContain("'triage owner/repo'");
    expect(CHAT_SYSTEM_SUFFIX).toContain("'review PRs on owner/repo'");
    expect(CHAT_SYSTEM_SUFFIX).toContain("'build owner/repo#N'");
  });

  it("warns-and-surfaces health instead of advertising a health command", () => {
    expect(CHAT_SYSTEM_SUFFIX.toLowerCase()).toContain("health");
    // No interactive health slash command should be advertised.
    expect(CHAT_SYSTEM_SUFFIX).not.toMatch(/`\/health/);
  });

  it("explicitly forbids leading-slash suggestions", () => {
    expect(CHAT_SYSTEM_SUFFIX).toMatch(/never suggest.*slash/i);
  });
});
