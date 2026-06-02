/**
 * Property-based test for filtered, ranked, bounded web search results.
 *
 * Feature: auxify-ai-platform, Property 19: Filtered results satisfy every
 * active filter.
 *
 * Design statement (Property 19): for any set of provider results and any
 * search request, every result the Web_Search_Engine returns satisfies the
 * active time-range window (Req 13.5) and the include/exclude-domain filters
 * (Req 13.6), the returned results are ordered by non-increasing relevance
 * score (Req 13.3), and the returned set never exceeds the requested maximum.
 *
 * Validates: Requirements 13.5, 13.6, 14.5, 29.4
 *
 * The test drives the real {@link WebSearchEngine} wired to a
 * {@link FakeSearchProviderAdapter} that returns an arbitrary, already-normalized
 * result population (varied hosts/subdomains/malformed URLs, varied publication
 * times including absent and unparseable, varied scores) against an arbitrary
 * request (arbitrary include/exclude domains, time range, search type, and
 * maxResults) at a fixed `now`. It then checks the engine's output against an
 * INDEPENDENT oracle implemented here from the requirement text — it never calls
 * the production `applyFilters`/`rankResults`/`hostOf` helpers — and asserts:
 *
 *   - soundness: every returned result's host matches the include list (when
 *     non-empty) and matches none of the exclude list, and every returned
 *     result falls inside the active time-range window (Req 13.5, 13.6);
 *   - ordering: the returned list is sorted by non-increasing score (Req 13.3);
 *   - bounding: the returned length never exceeds the normalized maxResults; and
 *   - completeness: the returned set equals the oracle's
 *     filtered-then-ranked-then-bounded set, so no result that should pass the
 *     filters is wrongly dropped.
 *
 * URLs embed each result's generated index, so they are unique and the
 * completeness/ordering comparison is an exact, unambiguous array equality.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Principal } from '@auxify/types';

import { FakeSearchProviderAdapter, makeWebSearchResult } from './fakes.js';
import {
  SEARCH_TYPES,
  TIME_RANGES,
  type SearchType,
  type TimeRange,
  type WebSearchRequest,
  type WebSearchResult,
} from './types.js';
import { WebSearchEngine } from './web-search-engine.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/** A representative principal; the engine reserves it for future attribution. */
const principal: Principal = {
  userId: 'user-1',
  organizationId: 'org-1',
  roles: ['standard_user'],
  teamIds: [],
  projectIds: [],
  allowedModels: [],
  premiumAuthorized: false,
};

/** A fixed "now" shared by the engine and the oracle so the time filter is deterministic. */
const NOW = Date.parse('2024-06-15T00:00:00.000Z');

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/** The engine's default maximum result count (mirrors DEFAULT_MAX_RESULTS). */
const DEFAULT_MAX_RESULTS = 10;

/** The trailing span, in milliseconds, of each finite time range (independent of production). */
const SPAN_MS: Readonly<Record<Exclude<TimeRange, 'all'>, number>> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

/** Base registrable domains for generated result hosts. */
const BASE_DOMAINS = ['example.com', 'test.org', 'news.io', 'sub.co'] as const;

/** Subdomain prefixes (including `www.` and a multi-label one) for generated hosts. */
const SUBDOMAINS = ['', 'news.', 'www.', 'a.b.', 'shop.'] as const;

/**
 * Domains drawn for include/exclude filters. Deliberately mixes exact domains,
 * a subdomain-specific domain, a `www.`-prefixed domain (to exercise
 * normalization), an empty string (which must be ignored), and a domain that
 * matches nothing in the population.
 */
const FILTER_DOMAIN_POOL = [
  'example.com',
  'test.org',
  'news.io',
  'sub.co',
  'news.example.com',
  'www.test.org',
  'other.com',
  '',
] as const;

/** A generated publication-time variant: absent, a valid offset from NOW, or unparseable. */
type PublishedSpec =
  | { readonly kind: 'absent' }
  | { readonly kind: 'iso'; readonly offsetDays: number }
  | { readonly kind: 'invalid' };

/** A generated provider result: its URL shape, score, and publication time. */
interface ResultSpec {
  readonly urlKind: 'valid' | 'malformed';
  readonly sub: string;
  readonly base: string;
  readonly scoreTenths: number;
  readonly published: PublishedSpec;
}

const publishedArb: fc.Arbitrary<PublishedSpec> = fc.oneof(
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('absent' as const) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constant('iso' as const),
      // Positive => published in the past; negative => in the future relative to NOW.
      offsetDays: fc.integer({ min: -5, max: 500 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('invalid' as const) }) },
);

const resultSpecArb: fc.Arbitrary<ResultSpec> = fc.record({
  urlKind: fc.oneof(
    { weight: 9, arbitrary: fc.constant('valid' as const) },
    { weight: 1, arbitrary: fc.constant('malformed' as const) },
  ),
  sub: fc.constantFrom(...SUBDOMAINS),
  base: fc.constantFrom(...BASE_DOMAINS),
  scoreTenths: fc.integer({ min: 0, max: 10 }),
  published: publishedArb,
});

const requestArb = fc.record({
  includeDomains: fc.option(fc.array(fc.constantFrom(...FILTER_DOMAIN_POOL), { maxLength: 4 }), {
    nil: undefined,
  }),
  excludeDomains: fc.option(fc.array(fc.constantFrom(...FILTER_DOMAIN_POOL), { maxLength: 4 }), {
    nil: undefined,
  }),
  timeRange: fc.option(fc.constantFrom(...TIME_RANGES), { nil: undefined }),
  searchType: fc.option(fc.constantFrom(...SEARCH_TYPES), { nil: undefined }),
  maxResults: fc.option(fc.integer({ min: -3, max: 25 }), { nil: undefined }),
});

const scenarioArb = fc.record({
  specs: fc.array(resultSpecArb, { maxLength: 25 }),
  request: requestArb,
});

/** Build a unique URL for the result at `index`; malformed URLs have no parseable host. */
function buildUrl(spec: ResultSpec, index: number): string {
  if (spec.urlKind === 'malformed') {
    return `malformed-no-scheme-${index}`;
  }
  return `https://${spec.sub}${spec.base}/p${index}`;
}

/** Materialize the ISO publication time (or `undefined`) for a generated spec. */
function buildPublishedAt(spec: ResultSpec): string | undefined {
  switch (spec.published.kind) {
    case 'absent':
      return undefined;
    case 'invalid':
      return 'not-a-real-date';
    case 'iso':
      return new Date(NOW - spec.published.offsetDays * DAY_MS).toISOString();
  }
}

/** Turn a generated spec into a normalized provider result with a unique URL. */
function buildResult(spec: ResultSpec, index: number): WebSearchResult {
  return makeWebSearchResult(buildUrl(spec, index), {
    score: spec.scoreTenths / 10,
    publishedAt: buildPublishedAt(spec),
  });
}

// --- Independent oracle (does NOT call the production filtering/ranking code) ---

/** Oracle host extraction: lower-cased hostname with a leading `www.` stripped, or null. */
function oracleHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** Oracle domain normalization: trimmed, lower-cased, leading `www.` stripped. */
function oracleNormalizeDomain(domain: string): string {
  let normalized = domain.trim().toLowerCase();
  if (normalized.startsWith('www.')) {
    normalized = normalized.slice(4);
  }
  return normalized;
}

/** Oracle domain match: exact host or a subdomain of the (non-empty) domain. */
function oracleMatchesDomain(host: string, domain: string): boolean {
  const normalized = oracleNormalizeDomain(domain);
  if (normalized.length === 0) {
    return false;
  }
  return host === normalized || host.endsWith(`.${normalized}`);
}

/** Oracle time-range membership relative to NOW. */
function oracleWithinTimeRange(
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
  return now - published <= SPAN_MS[range];
}

/** Oracle maxResults normalization: default on absent/non-positive/non-finite, else floored. */
function oracleNormalizeMax(maxResults: number | undefined): number {
  if (maxResults === undefined || !Number.isFinite(maxResults)) {
    return DEFAULT_MAX_RESULTS;
  }
  const floored = Math.floor(maxResults);
  return floored > 0 ? floored : DEFAULT_MAX_RESULTS;
}

/** Drop empty-after-trim filter domains, matching the engine's pre-filter step. */
function activeDomains(domains: string[] | undefined): string[] {
  return (domains ?? []).filter((d) => d.trim().length > 0);
}

/** The oracle's expected filtered-then-ranked-then-bounded result set. */
function expectedResults(results: WebSearchResult[], req: WebSearchRequest): WebSearchResult[] {
  const include = activeDomains(req.includeDomains);
  const exclude = activeDomains(req.excludeDomains);
  const range: TimeRange = req.timeRange ?? 'all';

  const survivors = results.filter((result) => {
    const host = oracleHost(result.url);

    if (include.length > 0) {
      if (host === null || !include.some((domain) => oracleMatchesDomain(host, domain))) {
        return false;
      }
    }
    if (exclude.length > 0 && host !== null) {
      if (exclude.some((domain) => oracleMatchesDomain(host, domain))) {
        return false;
      }
    }
    return oracleWithinTimeRange(result.publishedAt, range, NOW);
  });

  // Stable sort survivors (already in original relative order) by non-increasing
  // score, breaking ties by original position — mirroring the engine's ranking.
  const ranked = survivors
    .map((result, index) => ({ result, index }))
    .sort((a, b) => (b.result.score !== a.result.score ? b.result.score - a.result.score : a.index - b.index))
    .map((entry) => entry.result);

  return ranked.slice(0, oracleNormalizeMax(req.maxResults));
}

describe('Feature: auxify-ai-platform, Property 19: Filtered results satisfy every active filter', () => {
  it('returns only results satisfying every active filter, ranked by non-increasing relevance and bounded by maxResults', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const results = scenario.specs.map((spec, index) => buildResult(spec, index));

        const adapter = new FakeSearchProviderAdapter({
          providerId: 'fake',
          results,
        });
        const engine = new WebSearchEngine({
          adapters: [adapter],
          selectProvider: () => 'fake',
          now: () => NOW,
        });

        const req: WebSearchRequest = {
          query: 'q',
          searchType: scenario.request.searchType as SearchType | undefined,
          timeRange: scenario.request.timeRange,
          includeDomains: scenario.request.includeDomains,
          excludeDomains: scenario.request.excludeDomains,
          maxResults: scenario.request.maxResults,
        };

        const returned = await engine.search(req, principal);

        const include = activeDomains(req.includeDomains);
        const exclude = activeDomains(req.excludeDomains);
        const range: TimeRange = req.timeRange ?? 'all';

        // --- Soundness: every returned result satisfies every active filter ---
        for (const result of returned) {
          const host = oracleHost(result.url);

          // Include filter (Req 13.6): a non-empty include list requires a
          // parseable host matching at least one included domain.
          if (include.length > 0) {
            expect(host).not.toBeNull();
            expect(include.some((domain) => oracleMatchesDomain(host as string, domain))).toBe(
              true,
            );
          }

          // Exclude filter (Req 13.6): no returned result's host matches any
          // excluded domain.
          if (host !== null && exclude.length > 0) {
            expect(exclude.some((domain) => oracleMatchesDomain(host, domain))).toBe(false);
          }

          // Time-range window (Req 13.5): every returned result is within range.
          expect(oracleWithinTimeRange(result.publishedAt, range, NOW)).toBe(true);
        }

        // --- Ordering: non-increasing relevance score (Req 13.3) ---
        for (let i = 1; i < returned.length; i++) {
          expect(returned[i - 1]!.score).toBeGreaterThanOrEqual(returned[i]!.score);
        }

        // --- Bounding: never exceeds the normalized maxResults ---
        const maxResults = oracleNormalizeMax(req.maxResults);
        expect(returned.length).toBeLessThanOrEqual(maxResults);

        // --- Completeness + exact ordering: equals the oracle's filtered,
        // ranked, bounded set, so nothing that should pass is wrongly dropped ---
        const expected = expectedResults(results, req);
        expect(returned.map((r) => r.url)).toEqual(expected.map((r) => r.url));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
