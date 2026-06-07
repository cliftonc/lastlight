/**
 * Returns the number of whole weeks between two dates.
 *
 * - Order independent: `weeksBetween(a, b) === weeksBetween(b, a)`.
 * - Uses UTC epoch millisecond math via `getTime()` to avoid timezone/DST issues.
 * - Partial weeks are truncated (floored), so the result is always a non-negative integer.
 */
export function weeksBetween(a: Date, b: Date): number {
  const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

  const diffMs = Math.abs(a.getTime() - b.getTime());
  const weeks = Math.floor(diffMs / MS_PER_WEEK);

  return weeks;
}
