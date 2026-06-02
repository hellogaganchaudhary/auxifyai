/**
 * Feature: auxify-ai-platform, Property 20: Cached search is idempotent within
 * the deduplication window.
 *
 * Validates: Requirements 13.8
 *
 * _For any_ search submitted twice with identical parameters within the
 * deduplication window, the second call returns results equal to the first and
 * the underlying provider adapter is invoked exactly once.
 *
 * The Cache_Manager ({@link WebCacheManager}, task 13.4) realizes this by
 * deriving a deterministic key from the normalized search parameters and
 * serving a durable cache hit (or collapsing a concurrent burst via
 * single-flight) without re-invoking the provider. This suite pins down the
 * property end-to-end through the real {@link buildTestCacheManager} fakes — an
 * {@link InMemoryCacheStore} with Redis-style TTL eviction and a hand-advanced
 * {@link MutableClock} — never a mock of the manager itself.
 *
 * The provider is modeled as a "counting compute" that returns a DISTINCT value
 * on each invocation, so equality of two returned results is itself evidence
 * the provider ran once: if the cache had missed and recomputed, the second
 * value would differ. An INDEPENDENT oracle ({@link oracleSignature}) re-derives
 * the spec's normalization rules in the test (it does not call the module's
 * key-derivation code) to decide which generated key pairs SHOULD share a cache
 * entry; the cache's observed behavior is then asserted to match the oracle.
 *
 * Covered facets of Property 20:
 *  - idempotence + single invocation across N >= 2 repeated identical searches;
 *  - cosmetic variations (query whitespace; reordered / recased / duplicated
 *    domains) hit the same entry (provider still invoked once);
 *  - semantically different searches never collide (each recomputes), with the
 *    oracle deciding "different" vs "same";
 *  - the cache still serves within the window after a partial clock advance; and
 *  - TTL expiry past the deduplication window forces a recompute.
 *  - (single-flight) a concurrent burst of identical searches invokes once.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveSearchCacheKey } from './cache-key.js';
import { buildTestCacheManager } from './fakes.js';
import type { SearchKey, SearchTimeRange, SearchType } from './types.js';

/** Minimum generated iterations per property (>= 100). */
const NUM_RUNS = 200;

const SEARCH_TYPES: readonly SearchType[] = ['general', 'news', 'academic', 'code', 'images'];
const TIME_RANGES: readonly SearchTimeRange[] = ['day', 'week', 'month', 'year', 'all'];

// ---------------------------------------------------------------------------
// Provider model: every invocation yields a DISTINCT result, so "results equal"
// across two calls proves the provider was invoked once (a recompute would have
// produced a different value).
// ---------------------------------------------------------------------------

interface SearchResult {
  id: number;
  label: string;
}

interface CountingCompute {
  compute: () => Promise<SearchResult[]>;
  calls: () => number;
}

function countingCompute(): CountingCompute {
  let calls = 0;
  return {
    compute: async (): Promise<SearchResult[]> => {
      calls += 1;
      const n = calls;
      return [{ id: n, label: `result-${n}` }];
    },
    calls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Independent oracle: re-derive the spec's normalization (Req 13.6, 13.8) in
// the test so we can decide, without consulting the module, whether two keys
// SHOULD share a cache entry. Two searches collide iff this signature matches.
// ---------------------------------------------------------------------------

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ');
}

function normalizeDomains(domains: readonly string[] | undefined): string[] {
  if (domains === undefined) return [];
  const cleaned = domains.map((d) => d.trim().toLowerCase()).filter((d) => d.length > 0);
  return [...new Set(cleaned)].sort();
}

function oracleSignature(key: SearchKey): string {
  return JSON.stringify({
    q: normalizeQuery(key.query),
    type: key.searchType ?? 'general',
    time: key.timeRange ?? 'all',
    include: normalizeDomains(key.includeDomains),
    exclude: normalizeDomains(key.excludeDomains),
    max: key.maxResults ?? null,
    scope: key.scope ?? null,
  });
}

// ---------------------------------------------------------------------------
// Generators.
// ---------------------------------------------------------------------------

/** A non-empty, whitespace-free query token. */
const tokenArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_.'.split('')), {
    minLength: 1,
    maxLength: 8,
  })
  .map((cs) => cs.join(''));

/** A canonical query: 1..5 tokens joined by single spaces (already normalized). */
const coreQueryArb = fc.array(tokenArb, { minLength: 1, maxLength: 5 }).map((ts) => ts.join(' '));

/** Domains spanning the canonical pool plus arbitrary generated hosts, mixed case. */
const generalDomainArb = fc.oneof(
  fc.constantFrom('alpha.com', 'BETA.org', 'Gamma.net', 'delta.io', 'Epsilon.DEV'),
  tokenArb.map((t) => `${t}.com`),
);

/** A non-empty whitespace run (>= 1 char) for re-injecting cosmetic spacing. */
const wsRunArb = fc
  .array(fc.constantFrom(' ', '\t', '\n', '\f'), { minLength: 1, maxLength: 3 })
  .map((a) => a.join(''));

/** Possibly-empty leading/trailing whitespace. */
const optWsArb = fc
  .array(fc.constantFrom(' ', '\t', '\n'), { minLength: 0, maxLength: 3 })
  .map((a) => a.join(''));

/**
 * An arbitrary {@link SearchKey} exercising every dedup-relevant dimension:
 * query text (canonical, arbitrary, or empty), search type, time range,
 * include/exclude domains, max results, and isolation scope. Optional fields
 * may be absent or `undefined`.
 */
const searchKeyArb: fc.Arbitrary<SearchKey> = fc.record(
  {
    query: fc.oneof(coreQueryArb, fc.string({ maxLength: 24 }), fc.constant('')),
    searchType: fc.option(fc.constantFrom(...SEARCH_TYPES), { nil: undefined }),
    timeRange: fc.option(fc.constantFrom(...TIME_RANGES), { nil: undefined }),
    includeDomains: fc.option(fc.array(generalDomainArb, { maxLength: 4 }), { nil: undefined }),
    excludeDomains: fc.option(fc.array(generalDomainArb, { maxLength: 4 }), { nil: undefined }),
    maxResults: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    scope: fc.option(fc.constantFrom('org-1', 'org-2', 'team-7'), { nil: undefined }),
  },
  { requiredKeys: ['query'] },
);

/** A positive TTL in seconds (the deduplication window). */
const ttlSecondsArb = fc.integer({ min: 1, max: 86_400 });

// ---------------------------------------------------------------------------
// Property 20.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 20: Cached search is idempotent within the deduplication window', () => {
  it('returns equal results and invokes the provider exactly once across repeated identical searches (Validates: Requirements 13.8)', async () => {
    await fc.assert(
      fc.asyncProperty(
        searchKeyArb,
        fc.integer({ min: 2, max: 6 }),
        ttlSecondsArb,
        async (key, repeats, ttl) => {
          const { manager } = buildTestCacheManager();
          const { compute, calls } = countingCompute();

          const first = await manager.dedupeSearch<SearchResult>(key, ttl, compute);
          for (let i = 1; i < repeats; i += 1) {
            const again = await manager.dedupeSearch<SearchResult>(key, ttl, compute);
            // Idempotence: every repeat returns results equal to the first.
            expect(again).toEqual(first);
          }
          // Single provider invocation within the window.
          expect(calls()).toBe(1);
          // A plain get also observes the one cached result.
          expect(await manager.getSearch<SearchResult>(key)).toEqual(first);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('serves cosmetic variations (query whitespace, reordered/recased/duplicated domains) from the same entry (Validates: Requirements 13.8)', async () => {
    const cosmeticArb = fc.record({
      tokens: fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
      searchType: fc.option(fc.constantFrom(...SEARCH_TYPES), { nil: undefined }),
      timeRange: fc.option(fc.constantFrom(...TIME_RANGES), { nil: undefined }),
      includeDomains: fc.uniqueArray(fc.constantFrom('alpha.com', 'beta.org', 'gamma.net', 'delta.io'), {
        maxLength: 4,
      }),
      excludeDomains: fc.uniqueArray(fc.constantFrom('one.com', 'two.org', 'three.net'), {
        maxLength: 3,
      }),
      maxResults: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
      scope: fc.option(fc.constantFrom('org-1', 'org-2'), { nil: undefined }),
      // Cosmetic transform seeds:
      lead: optWsArb,
      trail: optWsArb,
      seps: fc.array(wsRunArb, { minLength: 4, maxLength: 4 }),
      incCase: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
      excCase: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
      incDup: fc.boolean(),
      excDup: fc.boolean(),
      ttl: ttlSecondsArb,
    });

    /** Reverse, recase per flag, and optionally duplicate the head — same set. */
    const recaseReorderDup = (domains: string[], caseFlags: boolean[], dup: boolean): string[] => {
      const recased = domains.map((d, i) => (caseFlags[i] === true ? d.toUpperCase() : d.toLowerCase()));
      const reversed = [...recased].reverse();
      const head = reversed[0];
      return dup && head !== undefined ? [head, ...reversed] : reversed;
    };

    await fc.assert(
      fc.asyncProperty(cosmeticArb, async (c) => {
        const baseQuery = c.tokens.join(' ');
        let variantQuery = c.lead + (c.tokens[0] ?? '');
        for (let i = 1; i < c.tokens.length; i += 1) {
          variantQuery += (c.seps[i - 1] ?? ' ') + (c.tokens[i] ?? '');
        }
        variantQuery += c.trail;

        const base: SearchKey = {
          query: baseQuery,
          searchType: c.searchType,
          timeRange: c.timeRange,
          includeDomains: c.includeDomains,
          excludeDomains: c.excludeDomains,
          maxResults: c.maxResults,
          scope: c.scope,
        };
        const variant: SearchKey = {
          query: variantQuery,
          searchType: c.searchType,
          timeRange: c.timeRange,
          includeDomains: recaseReorderDup(c.includeDomains, c.incCase, c.incDup),
          excludeDomains: recaseReorderDup(c.excludeDomains, c.excCase, c.excDup),
          maxResults: c.maxResults,
          scope: c.scope,
        };

        // Precondition: by construction the variant is canonically identical and
        // (cross-checked against the module) derives the same cache key.
        expect(oracleSignature(variant)).toBe(oracleSignature(base));
        expect(deriveSearchCacheKey(variant)).toBe(deriveSearchCacheKey(base));

        const { manager } = buildTestCacheManager();
        const { compute, calls } = countingCompute();

        const first = await manager.dedupeSearch<SearchResult>(base, c.ttl, compute);
        const second = await manager.dedupeSearch<SearchResult>(variant, c.ttl, compute);

        expect(second).toEqual(first);
        expect(calls()).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('shares a cache entry iff two searches are canonically identical, else each recomputes (Validates: Requirements 13.8)', async () => {
    await fc.assert(
      fc.asyncProperty(searchKeyArb, searchKeyArb, ttlSecondsArb, async (k1, k2, ttl) => {
        const { manager } = buildTestCacheManager();
        const { compute, calls } = countingCompute();

        const r1 = await manager.dedupeSearch<SearchResult>(k1, ttl, compute);
        const r2 = await manager.dedupeSearch<SearchResult>(k2, ttl, compute);

        const shouldCollide = oracleSignature(k1) === oracleSignature(k2);
        if (shouldCollide) {
          // Identical parameters: served from cache, provider invoked once.
          expect(r2).toEqual(r1);
          expect(calls()).toBe(1);
        } else {
          // Genuinely different parameters never collide: each recomputes.
          expect(calls()).toBe(2);
          expect(r2).not.toEqual(r1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('still serves from cache after a partial clock advance within the window (Validates: Requirements 13.8)', async () => {
    await fc.assert(
      fc.asyncProperty(
        searchKeyArb,
        ttlSecondsArb,
        fc.integer({ min: 0, max: 999 }),
        async (key, ttl, permille) => {
          const { manager, clock } = buildTestCacheManager();
          const { compute, calls } = countingCompute();

          const first = await manager.dedupeSearch<SearchResult>(key, ttl, compute);
          // ttl * permille ms < ttl * 1000 ms, i.e. strictly inside the window.
          clock.advanceMs(ttl * permille);
          const again = await manager.dedupeSearch<SearchResult>(key, ttl, compute);

          expect(again).toEqual(first);
          expect(calls()).toBe(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('recomputes once the deduplication window (TTL) has expired (Validates: Requirements 13.8)', async () => {
    await fc.assert(
      fc.asyncProperty(
        searchKeyArb,
        fc.integer({ min: 1, max: 3600 }),
        fc.integer({ min: 0, max: 86_400_000 }),
        async (key, ttl, extraMs) => {
          const { manager, clock } = buildTestCacheManager();
          const { compute, calls } = countingCompute();

          const first = await manager.dedupeSearch<SearchResult>(key, ttl, compute);
          expect(calls()).toBe(1);

          // Advance to or past the expiry boundary (expired when now >= expiresAt).
          clock.advanceMs(ttl * 1000 + extraMs);
          const afterExpiry = await manager.dedupeSearch<SearchResult>(key, ttl, compute);

          expect(calls()).toBe(2);
          expect(afterExpiry).not.toEqual(first);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('collapses a concurrent burst of identical searches into a single provider invocation (Validates: Requirements 13.8)', async () => {
    await fc.assert(
      fc.asyncProperty(
        searchKeyArb,
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 1, max: 3600 }),
        async (key, concurrency, ttl) => {
          const { manager } = buildTestCacheManager();
          let calls = 0;
          let release!: () => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const compute = async (): Promise<SearchResult[]> => {
            calls += 1;
            await gate;
            return [{ id: 1, label: 'concurrent' }];
          };

          const all = Promise.all(
            Array.from({ length: concurrency }, () =>
              manager.dedupeSearch<SearchResult>(key, ttl, compute),
            ),
          );
          release();
          const settled = await all;

          expect(calls).toBe(1);
          for (const r of settled) {
            expect(r).toEqual(settled[0]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
