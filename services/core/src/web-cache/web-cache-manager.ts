/**
 * Web_Cache_Manager — search/scrape deduplication and caching (Req 13.8, 14.8).
 *
 * The {@link WebCacheManager} is the design's `CacheManager`. It deduplicates
 * and caches Web_Search_Engine results and Web_Scraper output, keyed by
 * normalized search parameters / scrape URL, backed by the shared
 * {@link import('../storage/index.js').CacheStore} (Req 44.4). It deliberately
 * introduces **no** new cache backend: the only durable port is the existing
 * `CacheStore` (Redis in production, the in-memory fake in tests), composed
 * with an injectable {@link Clock} for deterministic `cachedAt` stamping.
 *
 * Two layers of deduplication uphold "identical parameters within the
 * deduplication window are served from cache with a single provider invocation"
 * (Req 13.8):
 *
 *  1. **Durable** — a hit in the `CacheStore` returns the stored value without
 *     invoking the provider, for the configured TTL (the deduplication window
 *     for searches, the retention period for scrapes — Req 13.8, 14.8).
 *  2. **Single-flight** — concurrent {@link WebCacheManager.dedupeSearch} /
 *     {@link WebCacheManager.dedupeScrape} calls for the same key that all miss
 *     the durable cache share one in-flight computation, so a burst of
 *     simultaneous identical requests still invokes the provider exactly once.
 *
 * Every method is generic over the provider value type so the manager owns no
 * search-result or scraped-content shape and stays decoupled from the
 * Web_Search_Engine (task 13.1) and Web_Scraper (task 13.6).
 */

import type { CacheStore } from '../storage/index.js';
import {
  deriveScrapeCacheKey,
  deriveSearchCacheKey,
} from './cache-key.js';
import { InvalidCacheTtlError } from './errors.js';
import {
  systemClock,
  type CachedEntry,
  type CacheManager,
  type Clock,
  type SearchKey,
} from './types.js';

/** Construction options for {@link WebCacheManager}. */
export interface WebCacheManagerOptions {
  /** The shared cache backend the manager composes (Req 44.4). Required. */
  cache: CacheStore;
  /** Clock for `cachedAt` stamping; defaults to {@link systemClock}. */
  clock?: Clock;
}

/**
 * Reject a TTL that is not a positive, finite number of seconds. The dedup
 * window (Req 13.8) and the scrape retention period (Req 14.8) are positive
 * durations; a non-positive TTL is a programming error.
 */
function assertValidTtl(ttlSeconds: number): void {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new InvalidCacheTtlError(ttlSeconds);
  }
}

/**
 * The Cache_Manager (design `CacheManager`): search/scrape deduplication and
 * caching over the shared {@link CacheStore} (Req 13.8, 14.8).
 */
export class WebCacheManager implements CacheManager {
  private readonly cache: CacheStore;
  private readonly clock: Clock;

  /**
   * In-process single-flight registry: a derived cache key → the promise of the
   * computation currently producing its value. Present only while a computation
   * is in flight; cleared (success or failure) when it settles, so a later
   * request recomputes after a failure rather than reusing a rejected promise.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(options: WebCacheManagerOptions) {
    this.cache = options.cache;
    this.clock = options.clock ?? systemClock;
  }

  // --- Search (Req 13.8) -------------------------------------------------

  async getSearch<R = unknown>(key: SearchKey): Promise<readonly R[] | null> {
    const cacheKey = deriveSearchCacheKey(key);
    const entry = await this.cache.get<CachedEntry<readonly R[]>>(cacheKey);
    return entry === null ? null : entry.value;
  }

  async putSearch<R = unknown>(
    key: SearchKey,
    results: readonly R[],
    ttlSeconds: number,
  ): Promise<void> {
    assertValidTtl(ttlSeconds);
    await this.writeEntry(deriveSearchCacheKey(key), results, ttlSeconds);
  }

  async dedupeSearch<R = unknown>(
    key: SearchKey,
    ttlSeconds: number,
    compute: () => Promise<readonly R[]>,
  ): Promise<readonly R[]> {
    assertValidTtl(ttlSeconds);
    return this.getOrCompute<readonly R[]>(deriveSearchCacheKey(key), ttlSeconds, compute);
  }

  /**
   * Return the cached search entry envelope (value plus `cachedAt`) for `key`,
   * or `null` if absent/expired. Useful for freshness/observability checks
   * without unwrapping in the caller.
   */
  async peekSearchEntry<R = unknown>(
    key: SearchKey,
  ): Promise<CachedEntry<readonly R[]> | null> {
    return this.cache.get<CachedEntry<readonly R[]>>(deriveSearchCacheKey(key));
  }

  // --- Scrape (Req 14.8) -------------------------------------------------

  async getScrape<C = unknown>(url: string, scope?: string): Promise<C | null> {
    const cacheKey = deriveScrapeCacheKey(url, scope);
    const entry = await this.cache.get<CachedEntry<C>>(cacheKey);
    return entry === null ? null : entry.value;
  }

  async putScrape<C = unknown>(
    url: string,
    content: C,
    ttlSeconds: number,
    scope?: string,
  ): Promise<void> {
    assertValidTtl(ttlSeconds);
    await this.writeEntry(deriveScrapeCacheKey(url, scope), content, ttlSeconds);
  }

  async dedupeScrape<C = unknown>(
    url: string,
    ttlSeconds: number,
    compute: () => Promise<C>,
    scope?: string,
  ): Promise<C> {
    assertValidTtl(ttlSeconds);
    return this.getOrCompute<C>(deriveScrapeCacheKey(url, scope), ttlSeconds, compute);
  }

  // --- Internals ---------------------------------------------------------

  /** Wrap `value` in a {@link CachedEntry} and store it under `cacheKey` with TTL. */
  private async writeEntry<T>(cacheKey: string, value: T, ttlSeconds: number): Promise<void> {
    const entry: CachedEntry<T> = { value, cachedAt: this.clock.now() };
    await this.cache.set(cacheKey, entry, ttlSeconds);
  }

  /**
   * The shared get-or-compute path with single-flight deduplication (Req 13.8).
   *
   * 1. A durable cache hit returns immediately (no computation).
   * 2. Otherwise, if a computation for `cacheKey` is already in flight, await
   *    its result — so concurrent identical requests collapse into one provider
   *    call.
   * 3. Otherwise, start the computation, register it for single-flight, and on
   *    success write the result to the durable cache. The in-flight entry is
   *    always cleared when the computation settles (success or failure).
   */
  private async getOrCompute<T>(
    cacheKey: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.cache.get<CachedEntry<T>>(cacheKey);
    if (cached !== null) {
      return cached.value;
    }

    const existing = this.inFlight.get(cacheKey) as Promise<T> | undefined;
    if (existing !== undefined) {
      return existing;
    }

    const computation = (async (): Promise<T> => {
      const value = await compute();
      await this.writeEntry(cacheKey, value, ttlSeconds);
      return value;
    })();

    this.inFlight.set(cacheKey, computation);
    try {
      return await computation;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }
}
