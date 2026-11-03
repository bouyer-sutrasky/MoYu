/**
 * Bounded in-memory limiter for the small, single-instance authentication
 * surface. It intentionally does not claim distributed enforcement: a future
 * multi-instance deployment must move this to a shared store.
 */
export interface RateLimiter {
  take(key: string): boolean;
  reset(): void;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return {
    take(key) {
      const timestamp = now();
      const existing = buckets.get(key);
      if (!existing || existing.resetAt <= timestamp) {
        buckets.set(key, { count: 1, resetAt: timestamp + options.windowMs });
        return true;
      }
      if (existing.count >= options.limit) {
        return false;
      }
      existing.count += 1;
      return true;
    },
    reset() {
      buckets.clear();
    },
  };
}
