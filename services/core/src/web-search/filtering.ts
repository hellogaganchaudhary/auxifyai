/**
 * Pure result-normalization, filtering, and ranking helpers for the
 * Web_Search_Engine (Req 13.3, 13.5, 13.6).
 *
 * These functions carry the engine's post-provider processing with no I/O, so
 * they are independently unit-testable and deterministic:
 *
 *  - {@link hostOf} extracts a result URL's lower-cased host for domain matching;
 *  - {@link matchesDomain} decides whether a host belongs to a domain (exact or
 *    subdomain), the basis of the include/exclude filters (Req 13.6);
 *  - {@link withinTimeRange} decides whether a result's publication time falls
 *    inside a recency window (Req 13.5);
 *  - {@link applyFilters} applies the active domain and time-range filters to a
 *    result set so every survivor satisfies all include constraints and
 *    violates none of the exclude constraints (Req 13.5, 13.6, Property 19);
 *  - {@link rankResults} orders results by non-increasing relevance score
 *    (Req 13.3).
 */

import type { TimeRange, WebSearchResult } from './types.js';

/** Milliseconds in one day, the unit of every recency window. */
const DAY_MS = 86_400_000;

/** The trailing span, in milliseconds, of each finite {@link TimeRange}. */
const TIME_RANGE_SPAN_MS: Readonly<Record<Exclude<TimeRange, 'all'>, number>> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

/**
 * Extract the lower-cased host of a URL, or `null` when it cannot be parsed
 * (Req 13.6).
 *
 * A `www.` prefix is stripped so `www.example.com` and `example.com` match the
 * same domain filter. An unparseable URL yields `null` so the caller can decide
 * how to treat it (the include/exclude filters treat a hostless result as
 * non-matching).
 *
 * @param url The result URL.
 * @returns The normalized host, or `null` when the URL has no parseable host.
 */
export function hostOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * True iff `host` belongs to `domain` — an exact match or a subdomain of it
 * (Req 13.6).
 *
 * For example `news.example.com` matches the domain `example.com`, but
 * `notexample.com` does not. The domain is normalized the same way as
 * {@link hostOf} (lower-cased, `www.` stripped) so filters are case- and
 * `www`-insensitive.
 *
 * @param host A normalized result host (from {@link hostOf}).
 * @param domain The filter domain to test against.
 * @returns `true` when `host` is `domain` or a subdomain of it.
 */
export function matchesDomain(host: string, domain: string): boolean {
  let normalized = domain.trim().toLowerCase();
  if (normalized.startsWith('www.')) {
    normalized = normalized.slice(4);
  }
  if (normalized.length === 0) {
    return false;
  }
  return host === normalized || host.endsWith(`.${normalized}`);
}

/**
 * True iff a result published at `publishedAt` falls within `range` relative to
 * `now` (Req 13.5).
 *
 * The unbounded `all` range admits every result, including results with no
 * publication time. For a finite range, a result is kept only when it has a
 * parseable publication time that is no older than the window's trailing span
 * (and not in the future relative to `now`). A result lacking a publication
 * time cannot be proven to satisfy a finite window, so it is excluded — keeping
 * the filter sound (Property 19).
 *
 * @param publishedAt The result's ISO-8601 publication time, if any.
 * @param range The active recency window.
 * @param now The reference "now" in epoch milliseconds.
 * @returns `true` when the result satisfies the time-range constraint.
 */
export function withinTimeRange(
  publishedAt: string | undefined,
  range: TimeRange,
  now: number,
): boolean {
  if (range === 'all') {
    return true;
  }
  if (publishedAt === undefined) {
    return false;
  }
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) {
    return false;
  }
  if (published > now) {
    return false;
  }
  return now - published <= TIME_RANGE_SPAN_MS[range];
}

/** The active filters {@link applyFilters} enforces. */
export interface ActiveFilters {
  /** Keep only results whose host matches one of these domains (Req 13.6). */
  includeDomains?: string[];
  /** Drop any result whose host matches one of these domains (Req 13.6). */
  excludeDomains?: string[];
  /** Keep only results published within this recency window (Req 13.5). */
  timeRange: TimeRange;
  /** The reference "now" in epoch milliseconds for the time-range test. */
  now: number;
}

/**
 * Return only the results that satisfy every active filter (Req 13.5, 13.6,
 * Property 19).
 *
 * A result survives iff:
 *  - when `includeDomains` is non-empty, its host matches at least one included
 *    domain (a result with no parseable host never matches, so it is dropped);
 *  - its host matches none of the `excludeDomains`; and
 *  - it satisfies the {@link timeRange} window via {@link withinTimeRange}.
 *
 * The relative order of survivors is preserved, so a subsequent
 * {@link rankResults} call still sees the provider's ordering for the survivors.
 *
 * @param results The provider's normalized results.
 * @param filters The active include/exclude domain and time-range filters.
 * @returns The subset satisfying all include constraints and no exclude constraint.
 */
export function applyFilters(
  results: readonly WebSearchResult[],
  filters: ActiveFilters,
): WebSearchResult[] {
  const include = (filters.includeDomains ?? []).filter((d) => d.trim().length > 0);
  const exclude = (filters.excludeDomains ?? []).filter((d) => d.trim().length > 0);

  return results.filter((result) => {
    const host = hostOf(result.url);

    if (include.length > 0) {
      if (host === null || !include.some((domain) => matchesDomain(host, domain))) {
        return false;
      }
    }

    if (exclude.length > 0 && host !== null) {
      if (exclude.some((domain) => matchesDomain(host, domain))) {
        return false;
      }
    }

    return withinTimeRange(result.publishedAt, filters.timeRange, filters.now);
  });
}

/**
 * Order results by non-increasing relevance score (Req 13.3).
 *
 * The sort is stable: results with equal scores keep the provider's original
 * relative order, so a provider that already ranks ties meaningfully is
 * respected. The input array is not mutated.
 *
 * @param results The results to rank.
 * @returns A new array ordered best-first by {@link WebSearchResult.score}.
 */
export function rankResults(results: readonly WebSearchResult[]): WebSearchResult[] {
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      if (b.result.score !== a.result.score) {
        return b.result.score - a.result.score;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.result);
}
