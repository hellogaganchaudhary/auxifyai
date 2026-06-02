/**
 * Cache_Manager typed errors (Req 13.8, 14.8).
 *
 * The Cache_Manager validates its caching preconditions with dedicated, typed
 * errors so callers can branch on the exact failure without parsing messages:
 *
 *  - {@link InvalidCacheTtlError} — a put/dedupe was given a non-positive,
 *    non-finite TTL. The deduplication window (Req 13.8) and the scrape
 *    retention period (Req 14.8) are positive durations; a zero/negative TTL is
 *    a programming error, not a cache miss.
 *  - {@link InvalidScrapeUrlError} — a scrape URL could not be parsed, so no
 *    deterministic cache key can be derived for it (Req 14.8).
 *
 * Each projects into the platform-wide serializable {@link PlatformError}
 * (Req 46.8) so the same wire shape crosses the REST_API, the WebSocket_Gateway,
 * and the SDK, and carries structured, secret-free `details`.
 */

import { createPlatformError, type PlatformError } from '@auxify/types';

/** The stable machine-readable code for a non-positive cache TTL. */
export const INVALID_CACHE_TTL_CODE = 'WEB_CACHE_INVALID_TTL' as const;

/** The stable machine-readable code for an unparseable scrape URL. */
export const INVALID_SCRAPE_URL_CODE = 'WEB_CACHE_INVALID_SCRAPE_URL' as const;

/**
 * Thrown when a cache put/dedupe is given a TTL that is not a positive, finite
 * number of seconds (Req 13.8, 14.8).
 */
export class InvalidCacheTtlError extends Error {
  /** The rejected TTL value. */
  readonly ttlSeconds: number;

  constructor(ttlSeconds: number) {
    super(`Cache TTL must be a positive, finite number of seconds; received ${ttlSeconds}`);
    this.name = 'InvalidCacheTtlError';
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `validation`, code {@link INVALID_CACHE_TTL_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_CACHE_TTL_CODE,
      message: this.message,
      correlationId,
      details: { ttlSeconds: this.ttlSeconds },
    });
  }
}

/**
 * Thrown when a scrape URL cannot be parsed into a normalizable URL, so no
 * deterministic cache key can be derived for it (Req 14.8).
 */
export class InvalidScrapeUrlError extends Error {
  /** The URL string that could not be parsed. */
  readonly url: string;

  constructor(url: string) {
    super(`Scrape URL "${url}" is not a valid URL and cannot be cached`);
    this.name = 'InvalidScrapeUrlError';
    this.url = url;
  }

  /**
   * Project this failure into the platform-wide serializable error shape
   * (category `validation`, code {@link INVALID_SCRAPE_URL_CODE}) (Req 46.8).
   *
   * @param correlationId Ties the error to logs/traces across services (Req 46.7).
   */
  toPlatformError(correlationId: string): PlatformError {
    return createPlatformError({
      category: 'validation',
      code: INVALID_SCRAPE_URL_CODE,
      message: this.message,
      correlationId,
      details: { url: this.url },
    });
  }
}
