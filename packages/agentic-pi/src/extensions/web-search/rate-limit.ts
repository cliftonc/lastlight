/**
 * Tiny per-run call counter. Shared between web_search and web_fetch so the
 * combined call count is bounded.
 *
 * When `max` is exceeded `consume()` returns false; the tool layer surfaces
 * this as a structured error result (never throws).
 */

export class RateLimiter {
  private used = 0;
  constructor(readonly max: number) {}

  consume(): boolean {
    if (this.used >= this.max) return false;
    this.used += 1;
    return true;
  }

  get remaining(): number {
    return Math.max(0, this.max - this.used);
  }
}
