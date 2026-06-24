/**
 * Shared date/duration helpers.
 *
 * Numbers are interpreted as **unix seconds** (not milliseconds), mirroring the
 * CLI `age()` helper in `src/cli-format.ts`.
 *
 * The main export, {@link humanDurationBetween}, returns a compact string
 * representing the absolute time difference between two dates, using the
 * largest appropriate unit: seconds, minutes, hours, or days.
 */

export type DateLike = string | number | Date;

/**
 * Convert a supported date-like value to epoch milliseconds.
 *
 * - `null`, `undefined`, and empty strings are treated as invalid → `null`.
 * - `Date` instances use `getTime()`.
 * - `number` values are interpreted as **unix seconds** and multiplied by 1000.
 * - `string` values are parsed via `Date.parse`; unparseable strings → `null`.
 */
function toMillis(input: DateLike | null | undefined): number | null {
  if (input === null || input === undefined) return null;

  if (input instanceof Date) {
    const time = input.getTime();
    return Number.isNaN(time) ? null : time;
  }

  if (typeof input === "number") {
    // Treat as unix seconds, not milliseconds.
    return input * 1000;
  }

  const str = String(input).trim();
  if (str.length === 0) return null;

  const parsed = Date.parse(str);
  if (Number.isNaN(parsed)) return null;

  return parsed;
}

/**
 * Compute a human-readable duration between two dates.
 *
 * Supported inputs:
 * - ISO-8601 strings or any format accepted by `Date.parse()`
 * - `Date` instances
 * - `number` values interpreted as **unix seconds** (not ms)
 *
 * The result is a compact, unit-only string with no "ago" suffix, using
 * rounded values:
 *
 * - `< 60` seconds → `"Xs"`
 * - `< 60` minutes → `"Xm"`
 * - `< 48` hours  → `"Xh"`
 * - otherwise     → `"Xd"`
 *
 * If either input is invalid, returns the explicit marker `"invalid date range"`.
 */
export function humanDurationBetween(
  start: DateLike | null | undefined,
  end: DateLike | null | undefined,
): string {
  const startMs = toMillis(start);
  const endMs = toMillis(end);

  if (startMs === null || endMs === null) {
    return "invalid date range";
  }

  const diffMs = Math.abs(endMs - startMs);

  const sec = Math.round(diffMs / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }

  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }

  const hr = Math.round(min / 60);
  if (hr < 48) {
    return `${hr}h`;
  }

  const days = Math.round(hr / 24);
  return `${days}d`;
}
