/**
 * Deterministic cache-key derivation for the Cache_Manager (Req 13.8, 14.8).
 *
 * Deduplication is only as good as the key: two requests must collide on the
 * same key iff they are "identical parameters" (Req 13.8). These helpers
 * normalize the request shape before hashing so that:
 *
 *  - cosmetic differences (leading/trailing whitespace, repeated spaces, the
 *    case of a domain, the order of include/exclude domains, a duplicated
 *    domain) collapse to the same key; while
 *  - semantically different requests (different query text, search type, time
 *    range, result count, included/excluded domains, scrape URL path/query, or
 *    isolation scope) derive different keys and never collide.
 *
 * The key is a hex SHA-256 of a canonical JSON encoding of the normalized
 * fields, prefixed by a namespace so search and scrape keys can never alias
 * each other in the shared {@link import('../storage/index.js').CacheStore}.
 */

import { createHash } from 'node:crypto';

import { InvalidScrapeUrlError } from './errors.js';
import type { SearchKey } from './types.js';

/** Namespace prefix for cached search keys in the shared CacheStore. */
export const SEARCH_KEY_PREFIX = 'web:search:' as const;

/** Namespace prefix for cached scrape keys in the shared CacheStore. */
export const SCRAPE_KEY_PREFIX = 'web:scrape:' as const;

/** Collapse internal whitespace runs to a single space and trim the ends. */
function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

/**
 * Normalize a domain list to a lower-cased, trimmed, de-duplicated, sorted
 * array so the filter is order- and case-independent (Req 13.6). Empty/blank
 * entries are dropped; an absent or all-blank list normalizes to `[]`.
 */
function normalizeDomains(domains: readonly string[] | undefined): string[] {
  if (domains === undefined) return [];
  const cleaned = domains
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
  return [...new Set(cleaned)].sort();
}

/** Hex SHA-256 of `canonical`, giving a fixed-length, collision-resistant key. */
function digest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Derive the canonical, normalized form of a {@link SearchKey}.
 *
 * Exposed for tests and observability; {@link deriveSearchCacheKey} hashes this
 * into the stored key. Field names are fixed and the object is serialized in a
 * stable field order so the encoding is deterministic across processes.
 */
export function canonicalizeSearchKey(key: SearchKey): string {
  const canonical = {
    q: normalizeQuery(key.query),
    type: key.searchType ?? 'general',
    time: key.timeRange ?? 'all',
    include: normalizeDomains(key.includeDomains),
    exclude: normalizeDomains(key.excludeDomains),
    max: key.maxResults ?? null,
    scope: key.scope ?? null,
  };
  return JSON.stringify(canonical);
}

/**
 * Derive the namespaced, deterministic cache key for a search (Req 13.8).
 *
 * Equal-after-normalization searches yield an equal key (so the second call is
 * served from cache and the provider is invoked once); any semantic difference
 * yields a different key (so distinct searches never collide).
 */
export function deriveSearchCacheKey(key: SearchKey): string {
  return `${SEARCH_KEY_PREFIX}${digest(canonicalizeSearchKey(key))}`;
}

/**
 * Normalize a scrape URL to its canonical form for caching (Req 14.8).
 *
 * Normalization lower-cases the scheme and host, drops a default port, removes
 * a trailing slash from a non-root path, and sorts query parameters so
 * cosmetically different URLs that address the same resource share a cache
 * entry. The fragment is dropped (it never reaches the server). Throws
 * {@link InvalidScrapeUrlError} when `url` cannot be parsed.
 */
export function normalizeScrapeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new InvalidScrapeUrlError(url);
  }
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';
  // Sort query params for order-independence.
  parsed.searchParams.sort();
  // Strip a trailing slash from a non-root path (`/a/` ≡ `/a`).
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed.toString();
}

/**
 * Derive the namespaced, deterministic cache key for a scrape (Req 14.8).
 *
 * `scope` (e.g. an Organization id) is folded in when present so a tenant's
 * cached scrapes never leak across the tenant boundary (Req 1.4); absent keeps
 * the entry global.
 */
export function deriveScrapeCacheKey(url: string, scope?: string): string {
  const canonical = JSON.stringify({
    url: normalizeScrapeUrl(url),
    scope: scope ?? null,
  });
  return `${SCRAPE_KEY_PREFIX}${digest(canonical)}`;
}
