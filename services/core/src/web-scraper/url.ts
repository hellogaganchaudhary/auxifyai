/**
 * Pure URL helpers for the Web_Scraper (Req 14.5, 14.6).
 *
 * The scraper has to derive a few facts from a URL before it issues a request:
 * the origin to read `robots.txt` from, the path-plus-query to test disallow
 * rules against (Req 14.5), and the host to rate-limit per domain (Req 14.6).
 * It also fails closed on any URL that is not an absolute `http`/`https` URL so
 * it never fetches an unexpected scheme. These helpers are pure and total
 * (returning `null` instead of throwing) so the orchestration code can map a
 * parse failure to a typed {@link import('./errors.js').InvalidUrlError}.
 */

/** The parsed parts of a scrape URL the scraper needs. */
export interface ParsedUrl {
  /** The scheme + host (+ port), e.g. `https://example.com`. */
  origin: string;
  /** The lower-cased host, used as the per-domain rate-limit key (Req 14.6). */
  host: string;
  /** The path + query (+ fragment), tested against `robots.txt` rules (Req 14.5). */
  pathAndQuery: string;
  /** The normalized absolute URL. */
  href: string;
}

/** The URL schemes the scraper is allowed to fetch. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Parse and validate a scrape URL, returning its parts or `null` when it is not
 * a usable absolute `http`/`https` URL.
 *
 * @param url The candidate URL string.
 * @returns The parsed parts, or `null` when invalid.
 */
export function parseScrapeUrl(url: string): ParsedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return null;
  }
  if (parsed.hostname.length === 0) {
    return null;
  }
  return {
    origin: parsed.origin,
    host: parsed.hostname.toLowerCase(),
    pathAndQuery: `${parsed.pathname}${parsed.search}`,
    href: parsed.href,
  };
}

/**
 * Resolve a (possibly relative) link `href` against a `base` URL into an
 * absolute URL, returning the original string when it cannot be resolved.
 *
 * Used when extracting links (Req 14.3, `links` mode) so relative `<a href>`s
 * become absolute, navigable URLs.
 *
 * @param href The link target as it appears in the page.
 * @param base The page's URL to resolve against.
 * @returns The absolute URL, or the trimmed original when unresolvable.
 */
export function resolveUrl(href: string, base: string): string {
  const trimmed = href.trim();
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}
