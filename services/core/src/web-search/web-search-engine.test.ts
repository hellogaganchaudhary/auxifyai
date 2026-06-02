/**
 * Unit tests for the Web_Search_Engine and Search_Provider_Adapter
 * (Req 13.1-13.6, 13.9).
 *
 * These example-based tests cover the engine's discrete behaviors and edge
 * cases: configuration-driven provider selection with no hardcoded provider
 * (Req 13.1), rerouting when the configured provider changes (Req 13.2),
 * relevance ranking (Req 13.3), each search type (Req 13.4), time-range
 * restriction (Req 13.5), include/exclude-domain filtering (Req 13.6), the
 * provider-unavailable error (Req 13.9), and vendor-payload normalization.
 *
 * They wire the real {@link WebSearchEngine} to the in-memory fakes in
 * `./fakes.js` so they exercise the genuine orchestration with no real search
 * vendor or network.
 */

import { describe, expect, it } from 'vitest';

import type { Principal } from '@auxify/types';

import {
  NoSearchProviderConfiguredError,
  ProviderUnavailableError,
} from './errors.js';
import {
  FakeSearchProviderAdapter,
  NormalizingFakeAdapter,
  makeWebSearchResult,
  mutableSelector,
} from './fakes.js';
import { SEARCH_TYPES, type SearchType } from './types.js';
import { WebSearchEngine } from './web-search-engine.js';

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

/** A fixed "now" so time-range tests are deterministic. */
const NOW = Date.parse('2024-06-15T00:00:00.000Z');

describe('WebSearchEngine provider selection (Req 13.1, 13.2)', () => {
  it('routes a search to the configuration-selected provider', async () => {
    const serper = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [makeWebSearchResult('https://a.test', { score: 0.9 })],
    });
    const brave = new FakeSearchProviderAdapter({
      providerId: 'brave',
      results: [makeWebSearchResult('https://b.test', { score: 0.9 })],
    });
    const engine = new WebSearchEngine({
      adapters: [serper, brave],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q' }, principal);

    expect(serper.requests).toHaveLength(1);
    expect(brave.requests).toHaveLength(0);
    expect(results.map((r) => r.url)).toEqual(['https://a.test']);
  });

  it('reroutes to a newly configured provider without code changes (Req 13.2)', async () => {
    const serper = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [makeWebSearchResult('https://serper.test', { score: 0.9 })],
    });
    const brave = new FakeSearchProviderAdapter({
      providerId: 'brave',
      results: [makeWebSearchResult('https://brave.test', { score: 0.9 })],
    });
    const selector = mutableSelector('serper');
    const engine = new WebSearchEngine({
      adapters: [serper, brave],
      selectProvider: selector.get,
      now: () => NOW,
    });

    const first = await engine.search({ query: 'q' }, principal);
    expect(first.map((r) => r.url)).toEqual(['https://serper.test']);

    // An administrator changes the configured provider at runtime.
    selector.set('brave');

    const second = await engine.search({ query: 'q' }, principal);
    expect(second.map((r) => r.url)).toEqual(['https://brave.test']);
    expect(serper.requests).toHaveLength(1);
    expect(brave.requests).toHaveLength(1);
  });

  it('throws when no provider is configured (Req 13.1)', async () => {
    const engine = new WebSearchEngine({
      adapters: [new FakeSearchProviderAdapter({ providerId: 'serper' })],
      selectProvider: () => undefined,
    });
    await expect(engine.search({ query: 'q' }, principal)).rejects.toBeInstanceOf(
      NoSearchProviderConfiguredError,
    );
  });

  it('throws when no adapters are registered at all (Req 13.1)', async () => {
    const engine = new WebSearchEngine({ adapters: [], selectProvider: () => 'serper' });
    await expect(engine.search({ query: 'q' }, principal)).rejects.toBeInstanceOf(
      NoSearchProviderConfiguredError,
    );
  });

  it('reports unavailable when the configured provider id is not registered (Req 13.9)', async () => {
    const engine = new WebSearchEngine({
      adapters: [new FakeSearchProviderAdapter({ providerId: 'serper' })],
      selectProvider: () => 'ghost',
    });
    await expect(engine.search({ query: 'q' }, principal)).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      providerId: 'ghost',
    });
  });
});

describe('WebSearchEngine relevance ranking (Req 13.3)', () => {
  it('orders results by non-increasing relevance score', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [
        makeWebSearchResult('https://low.test', { score: 0.2 }),
        makeWebSearchResult('https://high.test', { score: 0.95 }),
        makeWebSearchResult('https://mid.test', { score: 0.6 }),
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q' }, principal);

    expect(results.map((r) => r.url)).toEqual([
      'https://high.test',
      'https://mid.test',
      'https://low.test',
    ]);
  });

  it('bounds the result set to maxResults', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [
        makeWebSearchResult('https://a.test', { score: 0.9 }),
        makeWebSearchResult('https://b.test', { score: 0.8 }),
        makeWebSearchResult('https://c.test', { score: 0.7 }),
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q', maxResults: 2 }, principal);
    expect(results.map((r) => r.url)).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('WebSearchEngine search types (Req 13.4)', () => {
  it.each(SEARCH_TYPES)('passes search type "%s" through to the adapter', async (type) => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: (req) => [
        makeWebSearchResult('https://a.test', { score: 0.9, searchType: req.searchType }),
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q', searchType: type }, principal);

    expect(adapter.requests[0]?.searchType).toBe(type);
    expect(results[0]?.searchType).toBe(type);
  });

  it('defaults the search type to general when omitted', async () => {
    const adapter = new FakeSearchProviderAdapter({ providerId: 'serper', results: [] });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    await engine.search({ query: 'q' }, principal);
    expect(adapter.requests[0]?.searchType).toBe<SearchType>('general');
  });
});

describe('WebSearchEngine time-range restriction (Req 13.5)', () => {
  it('keeps only results published within the window', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [
        makeWebSearchResult('https://fresh.test', {
          score: 0.9,
          publishedAt: '2024-06-14T00:00:00.000Z', // 1 day before NOW
        }),
        makeWebSearchResult('https://stale.test', {
          score: 0.95,
          publishedAt: '2024-01-01T00:00:00.000Z', // months before NOW
        }),
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q', timeRange: 'week' }, principal);
    expect(results.map((r) => r.url)).toEqual(['https://fresh.test']);
  });

  it('excludes results lacking a publication time under a finite window', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [makeWebSearchResult('https://undated.test', { score: 0.9 })],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q', timeRange: 'day' }, principal);
    expect(results).toHaveLength(0);
  });

  it('admits every result under the unbounded "all" range', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [makeWebSearchResult('https://undated.test', { score: 0.9 })],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q', timeRange: 'all' }, principal);
    expect(results).toHaveLength(1);
  });
});

describe('WebSearchEngine domain filters (Req 13.6)', () => {
  it('keeps only results in the include list (incl. subdomains)', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [
        makeWebSearchResult('https://news.example.com/a', { score: 0.9 }),
        makeWebSearchResult('https://other.test/b', { score: 0.95 }),
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search(
      { query: 'q', includeDomains: ['example.com'] },
      principal,
    );
    expect(results.map((r) => r.url)).toEqual(['https://news.example.com/a']);
  });

  it('drops results in the exclude list', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      results: [
        makeWebSearchResult('https://spam.test/a', { score: 0.9 }),
        makeWebSearchResult('https://good.test/b', { score: 0.8 }),
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const results = await engine.search(
      { query: 'q', excludeDomains: ['spam.test'] },
      principal,
    );
    expect(results.map((r) => r.url)).toEqual(['https://good.test/b']);
  });
});

describe('WebSearchEngine provider availability (Req 13.9)', () => {
  it('returns a provider-unavailable error when the adapter is unavailable', async () => {
    const adapter = new FakeSearchProviderAdapter({ providerId: 'serper', available: false });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    const error = await engine.search({ query: 'q' }, principal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).providerId).toBe('serper');
    // It identifies the provider and never invokes search.
    expect(adapter.requests).toHaveLength(0);

    const platform = (error as ProviderUnavailableError).toPlatformError('corr-1');
    expect(platform.category).toBe('provider_unavailable');
    expect(platform.retriable).toBe(true);
    expect(platform.details).toEqual({ providerId: 'serper' });
  });

  it('maps a failed provider call to a provider-unavailable error', async () => {
    const adapter = new FakeSearchProviderAdapter({
      providerId: 'serper',
      throwOnSearch: new Error('network reset'),
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'serper',
      now: () => NOW,
    });

    await expect(engine.search({ query: 'q' }, principal)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe('Search_Provider_Adapter result normalization', () => {
  it('normalizes a vendor payload into the common shape, ranked by relevance', async () => {
    const adapter = new NormalizingFakeAdapter({
      providerId: 'vendor',
      raw: [
        { heading: 'Third', link: 'https://3.test', description: 'd3', position: 3 },
        { heading: 'First', link: 'https://1.test', description: 'd1', position: 1 },
        { heading: 'NoLink', link: '' }, // dropped during normalization
        { heading: 'Second', link: 'https://2.test', description: 'd2', position: 2 },
      ],
    });
    const engine = new WebSearchEngine({
      adapters: [adapter],
      selectProvider: () => 'vendor',
      now: () => NOW,
    });

    const results = await engine.search({ query: 'q' }, principal);

    // The link-less entry was dropped; the rest are normalized and ranked by
    // descending score (1/position).
    expect(results.map((r) => r.url)).toEqual([
      'https://1.test',
      'https://2.test',
      'https://3.test',
    ]);
    for (const result of results) {
      expect(typeof result.title).toBe('string');
      expect(typeof result.snippet).toBe('string');
      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(1);
      expect(result.searchType).toBe('general');
    }
  });
});
