/**
 * Truncate a string in the middle so the result is at most `max` characters.
 *
 * - `max <= 0` → empty string
 * - `max === 1` → first character of `text`
 * - otherwise the result keeps a prefix and suffix of the original string
 *   separated by a single ellipsis character (…)
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return text[0] ?? "";

  const ellipsis = "…";
  const remaining = max - ellipsis.length;

  const prefixLength = Math.ceil(remaining / 2);
  const suffixLength = Math.floor(remaining / 2);

  const start = text.slice(0, prefixLength);
  const end = text.slice(text.length - suffixLength);

  return `${start}${ellipsis}${end}`;
}
