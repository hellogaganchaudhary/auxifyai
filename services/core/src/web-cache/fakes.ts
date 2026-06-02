/**
 * Test fakes for the Cache_Manager (Req 13.8, 14.8).
 *
 * The Cache_Manager's only durable dependency is the shared
 * {@link import('../storage/index.js').CacheStore}, whose spec-faithful
 * in-memory backend ({@link InMemoryCacheStore}) already enforces Redis-style
 * TTL expiry (expired entries read as absent). It is re-exported here so a test
 * can build the manager without reaching into the storage barrel.
 *
 * {@link MutableClock} is the injectable {@link Clock} fake: a hand-advanced
 * millisecond clock so a test can stamp `cachedAt` deterministically and move
 * time forward across the deduplication window / retention period to exercise
 * TTL expiry. {@link buildTestCacheManager} wires an {@link InMemoryCacheStore}
 * and a {@link MutableClock} into a {@link WebCacheManager}, returning all three
 * so the test can advance the clock and inspect the cache.
 *
 * Tests import these fakes directly from `./fakes.js`, never from a package
 * barrel.
 */

import { InMemoryCacheStore } from '../storage/index.js';
import { WebCacheManager } from './web-cache-manager.js';
import type { Clock } from './types.js';

export { InMemoryCacheStore } from '../storage/index.js';

/**
 * A hand-advanced {@link Clock} for deterministic `cachedAt` stamping and TTL
 * tests.
 *
 * Construct it at a fixed epoch-ms origin (default `0`); read the current time
 * with {@link MutableClock.now}; move time forward with
 * {@link MutableClock.advance} (seconds) or {@link MutableClock.advanceMs}.
 * Pass the same instance to both the {@link InMemoryCacheStore} (so its lazy TTL
 * eviction sees the advanced time) and the {@link WebCacheManager}.
 */
export class MutableClock implements Clock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** Advance the clock by `seconds` (may be fractional). */
  advance(seconds: number): void {
    this.current += seconds * 1000;
  }

  /** Advance the clock by `ms` milliseconds. */
  advanceMs(ms: number): void {
    this.current += ms;
  }

  /** Set the clock to an absolute epoch-ms time. */
  set(ms: number): void {
    this.current = ms;
  }
}

/** The bundle {@link buildTestCacheManager} returns. */
export interface TestCacheManagerBundle {
  /** The Cache_Manager under test. */
  manager: WebCacheManager;
  /** The backing in-memory cache, sharing the clock for TTL eviction. */
  cache: InMemoryCacheStore;
  /** The shared, hand-advanced clock. */
  clock: MutableClock;
}

/**
 * Build a {@link WebCacheManager} over an {@link InMemoryCacheStore} and a
 * shared {@link MutableClock}, returning all three so a test can advance time
 * and inspect the cache. The clock is shared so the cache's TTL eviction and
 * the manager's `cachedAt` stamping observe the same timeline.
 */
export function buildTestCacheManager(startMs = 0): TestCacheManagerBundle {
  const clock = new MutableClock(startMs);
  const cache = new InMemoryCacheStore(() => clock.now());
  const manager = new WebCacheManager({ cache, clock });
  return { manager, cache, clock };
}
