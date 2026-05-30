/**
 * Truncate a string in the middle with an ellipsis so that the result length
 * is at most `max` characters.
 *
 * - If `max <= 0`, returns an empty string.
 * - If `max === 1`, returns only the ellipsis character.
 * - If the input length is already `<= max`, returns the original string.
 */
export function truncateMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;

  const ellipsis = "…";

  if (max === 1) return ellipsis;

  const remaining = max - ellipsis.length; // characters available for prefix + suffix
  const prefixLength = Math.ceil(remaining / 2);
  const suffixLength = Math.floor(remaining / 2);

  const prefix = text.slice(0, prefixLength);
  const suffix = text.slice(text.length - suffixLength);

  return prefix + ellipsis + suffix;
}
