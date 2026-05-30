/**
 * Truncate a string in the middle, inserting a single ellipsis character (…)
 * so that the resulting string length is at most `max`.
 *
 * Behaviour:
 * - If `text.length <= max`, the original `text` is returned unchanged.
 * - If `max <= 0`, an empty string is returned.
 * - If `max` is 1 or 2, a single ellipsis character is returned.
 * - Otherwise, the string is truncated keeping characters from the start and end
 *   with a single ellipsis between them.
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) {
    return "";
  }

  if (text.length <= max) {
    return text;
  }

  if (max <= 2) {
    return "…";
  }

  const remaining = max - 1; // reserve 1 char for ellipsis
  const frontLen = Math.ceil(remaining / 2);
  const backLen = Math.floor(remaining / 2);

  const start = text.slice(0, frontLen);
  const end = text.slice(text.length - backLen);

  return `${start}…${end}`;
}
