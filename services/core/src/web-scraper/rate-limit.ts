/**
 * Per-domain scrape rate limiting for the Web_Scraper (Req 14.6).
 *
 * While scraping a single domain the Web_Scraper enforces the configured
 * per-domain rate limit (Req 14.6). {@link IntervalRateLimiter} implements that
 * limit as a minimum interval between consecutive requests to the *same* host:
 * each host tracks the timestamp at which its next request becomes permissible,
 * and {@link IntervalRateLimiter.acquire} waits (via the injected
 * {@link Waiter}) until that time. Different hosts are independent, so a slow
 * domain never throttles another.
 *
 * The {@link Clock} and {@link Waiter} are injected so the limiter is fully
 * deterministic and instant in unit tests; production uses the real
 * {@link systemClock}/{@link systemWaiter}.
 */

import type { Clock, RateLimiter, Waiter } from './types.js';
import { systemClock, systemWaiter } from './types.js';

/** Options for the {@link IntervalRateLimiter}. */
export interface IntervalRateLimiterOptions {
  /** The minimum milliseconds between two requests to the same domain (Req 14.6). */
  minIntervalMs: number;
  /** Clock for measuring elapsed time; defaults to {@link systemClock}. */
  clock?: Clock;
  /** Waiter for the throttle delay; defaults to {@link systemWaiter}. */
  waiter?: Waiter;
}

/**
 * A {@link RateLimiter} that enforces a fixed minimum interval between requests
 * to each domain (Req 14.6).
 *
 * The first request to a host is permitted immediately; each subsequent request
 * to that host is delayed until at least `minIntervalMs` have elapsed since the
 * previous one. Acquisitions for the same host are serialized through a
 * per-host promise chain so concurrent callers are spaced correctly rather than
 * all reading the same "next allowed" timestamp.
 */
export class IntervalRateLimiter implements RateLimiter {
  private readonly minIntervalMs: number;
  private readonly clock: Clock;
  private readonly waiter: Waiter;
  /** Per-host tail of the acquisition chain; resolves to the host's last grant time. */
  private readonly chains = new Map<string, Promise<number>>();

  constructor(options: IntervalRateLimiterOptions) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs);
    this.clock = options.clock ?? systemClock;
    this.waiter = options.waiter ?? systemWaiter;
  }

  async acquire(domain: string): Promise<void> {
    const previous = this.chains.get(domain) ?? Promise.resolve(Number.NEGATIVE_INFINITY);
    const next = previous.then(async (lastGrant) => {
      const now = this.clock.now();
      const earliest = lastGrant === Number.NEGATIVE_INFINITY ? now : lastGrant + this.minIntervalMs;
      const delay = earliest - now;
      if (delay > 0) {
        await this.waiter.wait(delay);
      }
      // The grant time is the later of "now after waiting" and the earliest slot.
      return Math.max(earliest, this.clock.now());
    });
    // Swallow rejections on the stored chain so one failure doesn't poison the host.
    this.chains.set(
      domain,
      next.catch(() => this.clock.now()),
    );
    await next;
  }
}

/**
 * A no-op {@link RateLimiter} that permits every request immediately.
 *
 * Used where rate limiting is handled elsewhere (or disabled), and as a simple
 * default when no interval is configured.
 */
export class NoopRateLimiter implements RateLimiter {
  async acquire(_domain: string): Promise<void> {
    // Intentionally immediate.
  }
}
