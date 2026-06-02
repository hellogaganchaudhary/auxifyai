/**
 * Cache_Manager (Req 13.8, 14.8): search/scrape deduplication and caching.
 *
 * The {@link WebCacheManager} is the design's `CacheManager`. It deduplicates
 * and caches Web_Search_Engine results and Web_Scraper output so that, within
 * the configured window, repeated requests reuse a cached result instead of
 * re-hitting the provider:
 *
 *  - **Search (Req 13.8)** — `getSearch` / `putSearch` are the get/put
 *    primitives; `dedupeSearch` is the get-or-compute path that serves a hit
 *    from the cache and otherwise invokes the search provider exactly once per
 *    deduplication window. Keys are derived by
 *    {@link deriveSearchCacheKey} from normalized parameters (trimmed/collapsed
 *    query, case-folded order-independent include/exclude domains, search type,
 *    time range, result count, and optional isolation scope), so cosmetically
 *    different but identical searches dedupe while genuinely different searches
 *    never collide.
 *  - **Scrape (Req 14.8)** — `getScrape` / `putScrape` / `dedupeScrape` cache a
 *    successful scrape for the retention period, keyed by the
 *    {@link normalizeScrapeUrl}-normalized URL via {@link deriveScrapeCacheKey}.
 *
 * Beyond the durable cache, {@link WebCacheManager.dedupeSearch} /
 * {@link WebCacheManager.dedupeScrape} add **single-flight** deduplication:
 * concurrent identical requests that all miss the cache share one in-flight
 * computation, so a simultaneous burst still triggers exactly one provider
 * invocation (Req 13.8).
 *
 * The manager introduces **no** new cache backend — its only durable port is
 * the shared {@link import('../storage/index.js').CacheStore} (Redis in
 * production, the in-memory fake in tests, Req 44.4) — and reads an injectable
 * {@link CacheClock} for deterministic `cachedAt` stamping. It is generic over
 * the provider value type, so it owns no search-result or scraped-content shape
 * and stays decoupled from the Web_Search_Engine (task 13.1) and Web_Scraper
 * (task 13.6). Preconditions are enforced with typed errors
 * ({@link InvalidCacheTtlError}, {@link InvalidScrapeUrlError}) that project
 * into the platform-wide serializable {@link import('@auxify/types').PlatformError}
 * (Req 46.8). In-memory fakes for unit/property tests live in `./fakes.js`.
 *
 * The injectable clock is exported as {@link CacheClock} / {@link systemCacheClock}
 * (rather than `Clock` / `systemClock`) so the names never collide with the
 * Model_Router's identically-purposed clock in the shared `@auxify/core` barrel;
 * the search-parameter enums (`SearchType`, `SearchTimeRange`) stay internal to
 * this module for the same reason — a {@link SearchKey} is constructed directly
 * with their string-literal values.
 */

export {
  WebCacheManager,
  type WebCacheManagerOptions,
} from './web-cache-manager.js';

export {
  SEARCH_KEY_PREFIX,
  SCRAPE_KEY_PREFIX,
  canonicalizeSearchKey,
  deriveSearchCacheKey,
  normalizeScrapeUrl,
  deriveScrapeCacheKey,
} from './cache-key.js';

export {
  InvalidCacheTtlError,
  InvalidScrapeUrlError,
  INVALID_CACHE_TTL_CODE,
  INVALID_SCRAPE_URL_CODE,
} from './errors.js';

export {
  systemClock as systemCacheClock,
  type CacheManager,
  type CachedEntry,
  type Clock as CacheClock,
  type SearchKey,
} from './types.js';
