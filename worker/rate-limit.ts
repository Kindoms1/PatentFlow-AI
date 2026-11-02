/**
 * Sliding-window limiter kept in isolate memory. Best effort: Cloudflare may run several isolates,
 * and may evict/restart them at any time. Limits do not aggregate across isolates or survive restarts.
 * A hard shared quota needs coordinated storage such as Durable Objects; this only slows local bursts.
 * A nonpositive limit deliberately disables this local check.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    if (limit <= 0) return true;
    const since = now - windowMs;
    const list = (this.hits.get(key) || []).filter((time) => time > since);
    if (list.length >= limit) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.prune(now);
    return true;
  }

  private prune(now: number) {
    for (const [key, list] of this.hits) {
      if (!list.length || list[list.length - 1] < now - 86_400_000) this.hits.delete(key);
    }
  }
}
