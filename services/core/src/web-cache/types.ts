/**
 * Cache_Manager types for search/scrape deduplication (Req 13.8, 14.8).
 *
 * The Cache_Manager sits between the Web_Search_Engine / Web_Scraper and the
 * shared {@link import('../storage/index.js').CacheStore} (Req 44.4). It does
 * not introduce a new cache backend — it composes the existing `CacheStore`
 * (Redis in production, the in-memory fake in tests) behind a narrow,
 * search/scrape-shaped surface:
 *
 *  - a deterministic cache key derived from normalized search parameters
 *    ({@link SearchKey}) or a normalized scrape URL, so two requests that are
 *    identical after normalization collide on the same key (Req 13.8);
 *  - get / put primitives that mirror the design's `CacheManager` interface; and
 *  - a get-or-compute path with single-flight deduplication so concurrent
 *    identical requests collapse into a single provider invocation (Req 13.8).
 *
 * The value shapes (search results, scraped content) belong to the
 * Web_Search_Engine (task 13.1) and the Web_Scraper (task 13.6); the
 * Cache_Manager is intentionally generic over them so it owns no provider value
 * type and stays decoupled from either module.
 */

/** The search categories the Web_Search_Engine supports (Req 13.4). */
export type SearchType = 'general' | 'news' | 'academic' | 'code' | 'images';

/** The time-range filter a search may carry (Req 13.5). */
export type SearchTimeRange = 'day' | 'week' | 'month' | 'year' | 'all';

/**
 * The identity of a search for caching/deduplication purposes (Req 13.8).
 *
 * Two searches are "identical parameters" — and therefore served from one
 * cached result within the deduplication window — when they derive the same
 * cache key via {@link import('./cache-key.js').deriveSearchCacheKey}. Key
 * derivation normalizes the query (trimmed, internal whitespace collapsed) and
 * the domain filters (lower-cased, de-duplicated, order-independent) and folds
 * in the search type, time range, requested result count, and optional
 * isolation {@link SearchKey.scope}, so cosmetically different but semantically
 * identical searches dedupe while genuinely different searches do not collide.
 */
export interface SearchKey {
  /** The raw search query string. */
  query: string;
  /** The search category; absent is treated as `general` (Req 13.4). */
  searchType?: SearchType;
  /** The time-range filter; absent is treated as `all` (Req 13.5). */
  timeRange?: SearchTimeRange;
  /** Domains the search is restricted to; order-independent (Req 13.6). */
  includeDomains?: readonly string[];
  /** Domains excluded from the search; order-independent (Req 13.6). */
  excludeDomains?: readonly string[];
  /** The requested maximum number of results, when the caller bounds it. */
  maxResults?: number;
  /**
   * An optional isolation scope folded into the derived key (e.g. an
   * Organization id). When supplied, otherwise-identical searches from
   * different scopes never share a cache entry, so a tenant can be isolated
   * from another tenant's cached results (Req 1.4). Absent keeps the entry
   * global, maximizing the dedup hit rate for public web results.
   */
  scope?: string;
}

/**
 * A clock the Cache_Manager reads to stamp each cached entry with the time it
 * was computed. Injectable so tests can make `cachedAt` deterministic and
 * advance time to exercise TTL expiry.
 */
export interface Clock {
  /** The current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** The default {@link Clock}, backed by the global `Date.now`. */
export const systemClock: Clock = { now: () => Date.now() };

/**
 * The envelope the Cache_Manager stores in the {@link
 * import('../storage/index.js').CacheStore} for every cached search/scrape.
 *
 * Wrapping the provider value lets the manager record when the entry was
 * computed without the caller's value type having to carry that field. The TTL
 * itself is enforced by the underlying `CacheStore` (Redis expiry); `cachedAt`
 * supports freshness/observability checks such as {@link
 * import('./web-cache-manager.js').WebCacheManager.peekSearchEntry}.
 *
 * @typeParam T The wrapped provider value (search results or scraped content).
 */
export interface CachedEntry<T> {
  /** The cached provider value. */
  value: T;
  /** Epoch-ms timestamp, from the injected {@link Clock}, when the entry was written. */
  cachedAt: number;
}

/**
 * The Cache_Manager surface (design `CacheManager`, Req 13.8, 14.8).
 *
 * `getSearch` / `putSearch` / `getScrape` / `putScrape` are the get/put
 * primitives from the design; `dedupeSearch` / `dedupeScrape` add the
 * get-or-compute path with single-flight deduplication so a burst of identical
 * requests triggers exactly one provider invocation (Req 13.8). All methods are
 * generic over the provider value type, which the Web_Search_Engine (task 13.1)
 * and Web_Scraper (task 13.6) supply.
 */
export interface CacheManager {
  /** Return the cached results for `key`, or `null` if absent/expired (Req 13.8). */
  getSearch<R = unknown>(key: SearchKey): Promise<readonly R[] | null>;

  /**
   * Cache `results` for `key` for `ttlSeconds`, the deduplication window
   * (Req 13.8). Rejects a non-positive TTL with {@link
   * import('./errors.js').InvalidCacheTtlError}.
   */
  putSearch<R = unknown>(key: SearchKey, results: readonly R[], ttlSeconds: number): Promise<void>;

  /**
   * Return the cached results for `key` if present; otherwise invoke `compute`
   * exactly once, cache its result for `ttlSeconds`, and return it. Concurrent
   * calls for the same key share the single in-flight computation (Req 13.8).
   */
  dedupeSearch<R = unknown>(
    key: SearchKey,
    ttlSeconds: number,
    compute: () => Promise<readonly R[]>,
  ): Promise<readonly R[]>;

  /** Return the cached scraped content for `url`, or `null` if absent/expired (Req 14.8). */
  getScrape<C = unknown>(url: string, scope?: string): Promise<C | null>;

  /**
   * Cache scraped `content` for `url` for `ttlSeconds`, the retention period
   * (Req 14.8). Rejects a non-positive TTL with {@link
   * import('./errors.js').InvalidCacheTtlError} and an unparseable URL with
   * {@link import('./errors.js').InvalidScrapeUrlError}.
   */
  putScrape<C = unknown>(url: string, content: C, ttlSeconds: number, scope?: string): Promise<void>;

  /**
   * Return the cached scraped content for `url` if present; otherwise invoke
   * `compute` exactly once, cache its result for `ttlSeconds`, and return it.
   * Concurrent calls for the same URL share the single in-flight scrape
   * (Req 14.8).
   */
  dedupeScrape<C = unknown>(
    url: string,
    ttlSeconds: number,
    compute: () => Promise<C>,
    scope?: string,
  ): Promise<C>;
}
