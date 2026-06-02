/**
 * Unit tests for the Cache_Manager (Req 13.8, 14.8).
 *
 * Covers the behaviors the task calls out:
 *  - a cache hit reuses a result (provider invoked once);
 *  - a cache miss computes and stores;
 *  - TTL expiry forces a recompute;
 *  - identical concurrent requests dedupe to a single computation; and
 *  - distinct keys do not collide.
 *
 * Plus key-derivation normalization (cosmetic differences dedupe) and the typed
 * error preconditions.
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeSearchKey,
  deriveScrapeCacheKey,
  deriveSearchCacheKey,
  normalizeScrapeUrl,
} from './cache-key.js';
import { InvalidCacheTtlError, InvalidScrapeUrlError } from './errors.js';
import { buildTestCacheManager } from './fakes.js';
import type { SearchKey } from './types.js';

interface Result {
  title: string;
  url: string;
}

const baseKey: SearchKey = { query: 'auxify platform', searchType: 'general' };

function results(...titles: string[]): Result[] {
  return titles.map((title) => ({ title, url: `https://example.com/${title}` }));
}

describe('WebCacheManager search caching (Req 13.8)', () => {
  it('cache miss computes and stores; a subsequent hit reuses without recomputing', async () => {
    const { manager } = buildTestCacheManager();
    let calls = 0;
    const compute = async (): Promise<Result[]> => {
      calls += 1;
      return results('a', 'b');
    };

    const first = await manager.dedupeSearch<Result>(baseKey, 60, compute);
    expect(first).toEqual(results('a', 'b'));
    expect(calls).toBe(1);

    // Hit: same parameters within the window reuse the cached result.
    const second = await manager.dedupeSearch<Result>(baseKey, 60, compute);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('getSearch returns null on miss and the stored results on hit', async () => {
    const { manager } = buildTestCacheManager();
    expect(await manager.getSearch<Result>(baseKey)).toBeNull();

    await manager.putSearch<Result>(baseKey, results('x'), 60);
    expect(await manager.getSearch<Result>(baseKey)).toEqual(results('x'));
  });

  it('recomputes after the TTL deduplication window expires (Req 13.8)', async () => {
    const { manager, clock } = buildTestCacheManager();
    let calls = 0;
    const compute = async (): Promise<Result[]> => {
      calls += 1;
      return results(`gen-${calls}`);
    };

    const first = await manager.dedupeSearch<Result>(baseKey, 60, compute);
    expect(calls).toBe(1);

    // Still within the window: served from cache.
    clock.advance(59);
    await manager.dedupeSearch<Result>(baseKey, 60, compute);
    expect(calls).toBe(1);

    // Past the window: recomputed and the fresh result returned.
    clock.advance(2);
    const afterExpiry = await manager.dedupeSearch<Result>(baseKey, 60, compute);
    expect(calls).toBe(2);
    expect(afterExpiry).not.toEqual(first);
  });

  it('collapses concurrent identical searches into a single computation (Req 13.8)', async () => {
    const { manager } = buildTestCacheManager();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = async (): Promise<Result[]> => {
      calls += 1;
      await gate;
      return results('concurrent');
    };

    const all = Promise.all([
      manager.dedupeSearch<Result>(baseKey, 60, compute),
      manager.dedupeSearch<Result>(baseKey, 60, compute),
      manager.dedupeSearch<Result>(baseKey, 60, compute),
    ]);
    release();
    const [a, b, c] = await all;

    expect(calls).toBe(1);
    expect(a).toEqual(results('concurrent'));
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('does not collide distinct searches (different params recompute)', async () => {
    const { manager } = buildTestCacheManager();
    let calls = 0;
    const compute = (label: string) => async (): Promise<Result[]> => {
      calls += 1;
      return results(label);
    };

    await manager.dedupeSearch<Result>(baseKey, 60, compute('first'));
    // Different query, type, time range, and domain filters each miss.
    await manager.dedupeSearch<Result>({ ...baseKey, query: 'different' }, 60, compute('q'));
    await manager.dedupeSearch<Result>({ ...baseKey, searchType: 'news' }, 60, compute('type'));
    await manager.dedupeSearch<Result>({ ...baseKey, timeRange: 'week' }, 60, compute('time'));
    await manager.dedupeSearch<Result>(
      { ...baseKey, includeDomains: ['example.com'] },
      60,
      compute('dom'),
    );

    expect(calls).toBe(5);
  });

  it('isolates cached results by scope (Req 1.4)', async () => {
    const { manager } = buildTestCacheManager();
    await manager.putSearch<Result>({ ...baseKey, scope: 'org-1' }, results('one'), 60);

    expect(await manager.getSearch<Result>({ ...baseKey, scope: 'org-1' })).toEqual(results('one'));
    // A different tenant scope never sees org-1's cached result.
    expect(await manager.getSearch<Result>({ ...baseKey, scope: 'org-2' })).toBeNull();
    expect(await manager.getSearch<Result>(baseKey)).toBeNull();
  });

  it('recomputes after a failed computation rather than reusing a rejected promise', async () => {
    const { manager } = buildTestCacheManager();
    let calls = 0;
    const compute = async (): Promise<Result[]> => {
      calls += 1;
      if (calls === 1) throw new Error('provider boom');
      return results('recovered');
    };

    await expect(manager.dedupeSearch<Result>(baseKey, 60, compute)).rejects.toThrow('provider boom');
    const recovered = await manager.dedupeSearch<Result>(baseKey, 60, compute);
    expect(recovered).toEqual(results('recovered'));
    expect(calls).toBe(2);
  });
});

describe('WebCacheManager scrape caching (Req 14.8)', () => {
  const url = 'https://example.com/article';

  it('caches a successful scrape and reuses it within the retention period', async () => {
    const { manager } = buildTestCacheManager();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return '# Article';
    };

    const first = await manager.dedupeScrape<string>(url, 3600, compute);
    const second = await manager.dedupeScrape<string>(url, 3600, compute);
    expect(first).toBe('# Article');
    expect(second).toBe('# Article');
    expect(calls).toBe(1);
  });

  it('recomputes after the scrape retention period expires (Req 14.8)', async () => {
    const { manager, clock } = buildTestCacheManager();
    let calls = 0;
    const compute = async (): Promise<string> => {
      calls += 1;
      return `scrape-${calls}`;
    };

    await manager.dedupeScrape<string>(url, 3600, compute);
    clock.advance(3601);
    await manager.dedupeScrape<string>(url, 3600, compute);
    expect(calls).toBe(2);
  });

  it('collapses concurrent identical scrapes into a single fetch (Req 14.8)', async () => {
    const { manager } = buildTestCacheManager();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = async (): Promise<string> => {
      calls += 1;
      await gate;
      return 'content';
    };

    const all = Promise.all([
      manager.dedupeScrape<string>(url, 3600, compute),
      manager.dedupeScrape<string>(url, 3600, compute),
    ]);
    release();
    await all;
    expect(calls).toBe(1);
  });

  it('getScrape returns null on miss and the stored content on hit', async () => {
    const { manager } = buildTestCacheManager();
    expect(await manager.getScrape<string>(url)).toBeNull();
    await manager.putScrape<string>(url, 'cached', 3600);
    expect(await manager.getScrape<string>(url)).toBe('cached');
  });
});

describe('WebCacheManager TTL validation', () => {
  it('rejects a non-positive or non-finite TTL on put/dedupe', async () => {
    const { manager } = buildTestCacheManager();
    await expect(manager.putSearch(baseKey, results('a'), 0)).rejects.toBeInstanceOf(
      InvalidCacheTtlError,
    );
    await expect(manager.putSearch(baseKey, results('a'), -5)).rejects.toBeInstanceOf(
      InvalidCacheTtlError,
    );
    await expect(
      manager.dedupeSearch(baseKey, Number.POSITIVE_INFINITY, async () => results('a')),
    ).rejects.toBeInstanceOf(InvalidCacheTtlError);
    await expect(manager.putScrape('https://e.com', 'x', 0)).rejects.toBeInstanceOf(
      InvalidCacheTtlError,
    );
  });
});

describe('search cache-key derivation (Req 13.8)', () => {
  it('treats cosmetically different but identical searches as equal', () => {
    const a = deriveSearchCacheKey({ query: '  auxify   platform ', searchType: 'general' });
    const b = deriveSearchCacheKey({ query: 'auxify platform' });
    expect(a).toBe(b);
  });

  it('is order- and case-independent for domain filters', () => {
    const a = deriveSearchCacheKey({
      query: 'q',
      includeDomains: ['B.com', 'a.com', 'a.com'],
      excludeDomains: ['Z.org'],
    });
    const b = deriveSearchCacheKey({
      query: 'q',
      includeDomains: ['a.com', 'b.com'],
      excludeDomains: ['z.org'],
    });
    expect(a).toBe(b);
  });

  it('derives different keys for different semantic parameters', () => {
    const keys = new Set([
      deriveSearchCacheKey({ query: 'q' }),
      deriveSearchCacheKey({ query: 'q2' }),
      deriveSearchCacheKey({ query: 'q', searchType: 'news' }),
      deriveSearchCacheKey({ query: 'q', timeRange: 'week' }),
      deriveSearchCacheKey({ query: 'q', maxResults: 10 }),
      deriveSearchCacheKey({ query: 'q', includeDomains: ['a.com'] }),
      deriveSearchCacheKey({ query: 'q', excludeDomains: ['a.com'] }),
      deriveSearchCacheKey({ query: 'q', scope: 'org-1' }),
    ]);
    expect(keys.size).toBe(8);
  });

  it('canonicalizes absent optional fields to their defaults', () => {
    expect(canonicalizeSearchKey({ query: 'q' })).toBe(
      canonicalizeSearchKey({ query: 'q', searchType: 'general', timeRange: 'all' }),
    );
  });

  it('namespaces search and scrape keys so they never alias', () => {
    expect(deriveSearchCacheKey({ query: 'q' }).startsWith('web:search:')).toBe(true);
    expect(deriveScrapeCacheKey('https://e.com').startsWith('web:scrape:')).toBe(true);
  });
});

describe('scrape URL normalization (Req 14.8)', () => {
  it('lower-cases scheme/host, drops the fragment, sorts query params, trims trailing slash', () => {
    const a = normalizeScrapeUrl('HTTPS://Example.COM/Path/?b=2&a=1#frag');
    const b = normalizeScrapeUrl('https://example.com/Path?a=1&b=2');
    expect(a).toBe(b);
  });

  it('keeps distinct paths and query values distinct', () => {
    const keys = new Set([
      deriveScrapeCacheKey('https://e.com/a'),
      deriveScrapeCacheKey('https://e.com/b'),
      deriveScrapeCacheKey('https://e.com/a?x=1'),
      deriveScrapeCacheKey('https://e.com/a', 'org-1'),
    ]);
    expect(keys.size).toBe(4);
  });

  it('throws InvalidScrapeUrlError on an unparseable URL', () => {
    expect(() => normalizeScrapeUrl('not a url')).toThrow(InvalidScrapeUrlError);
    expect(() => deriveScrapeCacheKey('::::')).toThrow(InvalidScrapeUrlError);
  });
});
