/**
 * Convert standard Markdown to Slack's mrkdwn format.
 *
 * Uses an extract-then-transform pattern: code blocks and inline code
 * are pulled into placeholders first so their contents are never modified,
 * then restored after all transformations are applied.
 */
export function markdownToSlackMrkdwn(text: string): string {
  const placeholders: string[] = [];

  /** Replace a match with a numbered placeholder */
  function hold(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  }

  let out = text;

  // 1. Extract fenced code blocks (strip language hints)
  out = out.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (_m, code) => hold("```\n" + code + "```"));

  // 2. Extract inline code
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => hold("`" + code + "`"));

  // 3. Headers → bold (Slack has no header mrkdwn)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // 4. Bold: **text** or __text__ → *text*
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // 5. Italic: remaining *text* (not preceded/followed by *) → _text_
  //    Only match single * that aren't part of ** (already converted to single *)
  //    Skip this — after bold conversion, single * are now bold markers in Slack.
  //    Markdown _italic_ already works in Slack as italic.

  // 6. Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // 7. Images: ![alt](url) → <url|alt> (must come before links)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // 8. Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // 9. Horizontal rules → em-dash line
  out = out.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, "———");

  // 10. Restore placeholders
  out = out.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[parseInt(idx)]);

  return out;
}
