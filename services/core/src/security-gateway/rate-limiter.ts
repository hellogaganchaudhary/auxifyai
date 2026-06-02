/**
 * Per-dimension rate limiting for the Security_Gateway (Req 34.3, 45.7).
 *
 * The gateway enforces rate limits per user, per API key, and per IP (Req 34.3).
 * {@link InMemoryRateLimiter} implements the {@link RateLimiter} port as a fixed
 * count per rolling window for each {@link RateLimitKey}: it keeps the timestamps
 * of recent admitted requests per `(dimension, id)` counter, drops those that
 * have aged out of the window, and admits a request only when *every* supplied
 * key is still under its limit.
 *
 * It is atomic and fail-closed in spirit: it first checks every key and admits
 * nothing if any one is over its limit (naming the exceeded dimension and a
 * retry-after hint), and only when all pass does it record the request against
 * each counter. Because a denied request is never counted, an admitted request
 * count never exceeds the configured limit for any dimension (Property 44).
 *
 * The limiter is time-injected through the gateway (it receives `nowMs` on every
 * `consume`), so it is fully deterministic in tests. It is in-memory and
 * single-process; production swaps in a distributed (e.g. Redis-backed)
 * implementation of the same port without changing the gateway.
 */

import type {
  RateLimitDecision,
  RateLimitDimension,
  RateLimiter,
  RateLimitKey,
} from './types.js';

/** A counter key string for a `(dimension, id)` pair. */
function counterKey(dimension: RateLimitDimension, id: string): string {
  return `${dimension}:${id}`;
}

/**
 * An in-memory {@link RateLimiter} enforcing a fixed count per rolling window
 * for each rate-limit key (Req 34.3).
 *
 * Suitable for tests and single-process deployments; production wires a
 * distributed limiter implementing the same port.
 */
export class InMemoryRateLimiter implements RateLimiter {
  /** Per-counter admitted-request timestamps (epoch ms), pruned lazily on access. */
  private readonly hits = new Map<string, number[]>();

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async consume(keys: readonly RateLimitKey[], nowMs: number): Promise<RateLimitDecision> {
    // Phase 1 — check every key against its window without recording anything.
    for (const key of keys) {
      const windowMs = key.limit.windowSeconds * 1000;
      const recent = this.recentHits(counterKey(key.dimension, key.id), nowMs, windowMs);
      if (recent.length >= key.limit.requestsPerWindow) {
        // The oldest in-window hit determines when a slot frees up.
        const oldest = recent[0] ?? nowMs;
        const retryAfterMs = oldest + windowMs - nowMs;
        return {
          allowed: false,
          exceededDimension: key.dimension,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        };
      }
    }

    // Phase 2 — every key passed; record the request against each counter.
    for (const key of keys) {
      const id = counterKey(key.dimension, key.id);
      const windowMs = key.limit.windowSeconds * 1000;
      const recent = this.recentHits(id, nowMs, windowMs);
      recent.push(nowMs);
      this.hits.set(id, recent);
    }

    return { allowed: true };
  }

  /**
   * The in-window admitted-request timestamps for a counter, pruning any that
   * have aged out. Returns the live, pruned array so a caller may append to it.
   */
  private recentHits(id: string, nowMs: number, windowMs: number): number[] {
    const threshold = nowMs - windowMs;
    const pruned = (this.hits.get(id) ?? []).filter((t) => t > threshold);
    this.hits.set(id, pruned);
    return pruned;
  }
}

/**
 * A {@link RateLimiter} that admits every request — used where rate limiting is
 * handled elsewhere (or disabled). It records nothing and never denies.
 */
export class NoopRateLimiter implements RateLimiter {
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port
  async consume(): Promise<RateLimitDecision> {
    return { allowed: true };
  }
}
