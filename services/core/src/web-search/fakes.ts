/**
 * Test fakes and builders for the Web_Search_Engine and Search_Provider_Adapter
 * (Req 13.1-13.6, 13.9).
 *
 * The single injectable port the engine depends on is the
 * {@link SearchProviderAdapter}; these fakes implement it deterministically so
 * the engine's orchestration — configuration-driven provider selection,
 * availability gating, result normalization, filter enforcement, and relevance
 * ranking — can be unit-tested without any real search vendor or network:
 *
 *  - {@link FakeSearchProviderAdapter} returns a seeded, already-normalized
 *    {@link WebSearchResult} set, can be toggled available/unavailable
 *    (Req 13.9), can be made to throw on search, and records every request so a
 *    test can assert it was (or was not) invoked.
 *  - {@link NormalizingFakeAdapter} holds *vendor-shaped* raw payloads
 *    ({@link VendorRawResult}) and normalizes them into {@link WebSearchResult}
 *    via {@link normalizeVendorResults}, exercising the adapter's core job of
 *    mapping a provider's idiosyncratic payload into the common shape.
 *  - {@link mutableSelector} models a configuration value an administrator can
 *    change at runtime, so a test can prove the engine reroutes to a newly
 *    configured provider without any code change (Req 13.2).
 *
 * Import these directly from `./fakes.js` in tests, never from a package barrel.
 */

import {
  DEFAULT_SEARCH_TYPE,
  type SearchProviderAdapter,
  type SearchType,
  type WebSearchRequest,
  type WebSearchResult,
} from './types.js';

/**
 * Build a normalized {@link WebSearchResult} from a URL plus optional overrides.
 *
 * Defaults are deterministic so tests can assert exact values; `score` defaults
 * to `0.5` and `searchType` to {@link DEFAULT_SEARCH_TYPE}.
 */
export function makeWebSearchResult(
  url: string,
  overrides: Partial<WebSearchResult> = {},
): WebSearchResult {
  return {
    title: overrides.title ?? `Result for ${url}`,
    url,
    snippet: overrides.snippet ?? `Snippet for ${url}`,
    score: overrides.score ?? 0.5,
    searchType: overrides.searchType ?? DEFAULT_SEARCH_TYPE,
    ...(overrides.publishedAt !== undefined ? { publishedAt: overrides.publishedAt } : {}),
    ...(overrides.source !== undefined ? { source: overrides.source } : {}),
  };
}

/** Construction options for a {@link FakeSearchProviderAdapter}. */
export interface FakeSearchProviderAdapterOptions {
  /** The provider id (defaults to `fake`). */
  providerId?: string;
  /** Seeded results, or a function computing them from the request. */
  results?: WebSearchResult[] | ((req: WebSearchRequest) => WebSearchResult[]);
  /** Initial availability (defaults to `true`) (Req 13.9). */
  available?: boolean;
  /** When set, `search` throws this error to model a failed provider call (Req 13.9). */
  throwOnSearch?: Error;
}

/**
 * A deterministic {@link SearchProviderAdapter} returning pre-normalized
 * results.
 *
 * Toggle availability with {@link setAvailable} to drive the
 * provider-unavailable path (Req 13.9); set {@link FakeSearchProviderAdapterOptions.throwOnSearch}
 * to model a provider call that fails. Every {@link WebSearchRequest} is
 * recorded in {@link requests} so a test can assert the engine invoked (or
 * skipped) the provider and passed through the resolved type/filters.
 */
export class FakeSearchProviderAdapter implements SearchProviderAdapter {
  readonly providerId: string;
  /** Every request passed to {@link search}, in order. */
  readonly requests: WebSearchRequest[] = [];

  private readonly results: WebSearchResult[] | ((req: WebSearchRequest) => WebSearchResult[]);
  private available: boolean;
  private readonly throwOnSearch?: Error;

  constructor(options: FakeSearchProviderAdapterOptions = {}) {
    this.providerId = options.providerId ?? 'fake';
    this.results = options.results ?? [];
    this.available = options.available ?? true;
    if (options.throwOnSearch !== undefined) {
      this.throwOnSearch = options.throwOnSearch;
    }
  }

  /** Set the availability reported by {@link isAvailable} (Req 13.9). */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult[]> {
    this.requests.push(req);
    if (this.throwOnSearch !== undefined) {
      throw this.throwOnSearch;
    }
    const computed = typeof this.results === 'function' ? this.results(req) : this.results;
    return computed.map((result) => ({ ...result }));
  }
}

/**
 * A vendor-shaped raw result, mimicking the idiosyncratic payload a real search
 * API returns before normalization.
 *
 * The field names deliberately differ from {@link WebSearchResult} (`link` vs
 * `url`, `description` vs `snippet`, a 1-based `position` instead of a `[0, 1]`
 * `score`) so {@link normalizeVendorResults} exercises a genuine mapping.
 */
export interface VendorRawResult {
  /** The result heading (maps to {@link WebSearchResult.title}). */
  heading: string;
  /** The result link (maps to {@link WebSearchResult.url}). */
  link: string;
  /** The result description (maps to {@link WebSearchResult.snippet}). */
  description?: string;
  /** A 1-based rank position (mapped to a `[0, 1]` relevance score). */
  position?: number;
  /** A publication date string (maps to {@link WebSearchResult.publishedAt}). */
  date?: string;
  /** The origin site name (maps to {@link WebSearchResult.source}). */
  site?: string;
}

/**
 * Normalize a vendor's raw payload into the common {@link WebSearchResult} shape.
 *
 * Demonstrates the adapter's core responsibility: every provider's
 * idiosyncratic fields are mapped onto one stable contract. A 1-based
 * `position` is mapped to a descending `[0, 1]` relevance score (`1/position`)
 * so earlier vendor results rank higher; a missing position defaults to a
 * mid-range score. Entries without a usable link are dropped.
 *
 * @param raw The vendor's raw result entries.
 * @param searchType The search type these results were retrieved for (Req 13.4).
 * @returns The normalized results.
 */
export function normalizeVendorResults(
  raw: readonly VendorRawResult[],
  searchType: SearchType,
): WebSearchResult[] {
  const normalized: WebSearchResult[] = [];
  for (const entry of raw) {
    if (typeof entry.link !== 'string' || entry.link.length === 0) {
      continue;
    }
    const score =
      entry.position !== undefined && entry.position > 0 ? 1 / entry.position : 0.5;
    const result: WebSearchResult = {
      title: entry.heading,
      url: entry.link,
      snippet: entry.description ?? '',
      score,
      searchType,
    };
    if (entry.date !== undefined) {
      result.publishedAt = entry.date;
    }
    if (entry.site !== undefined) {
      result.source = entry.site;
    }
    normalized.push(result);
  }
  return normalized;
}

/** Construction options for a {@link NormalizingFakeAdapter}. */
export interface NormalizingFakeAdapterOptions {
  /** The provider id (defaults to `vendor`). */
  providerId?: string;
  /** The vendor-shaped raw payload the provider "returns" before normalization. */
  raw: readonly VendorRawResult[];
  /** Initial availability (defaults to `true`). */
  available?: boolean;
}

/**
 * A {@link SearchProviderAdapter} that holds vendor-shaped raw results and
 * normalizes them on each search via {@link normalizeVendorResults}.
 *
 * It models the realistic adapter path — receive a provider payload, normalize
 * it into {@link WebSearchResult} entries — so tests can assert that the engine
 * returns a uniformly-shaped, ranked result set regardless of the provider's
 * native payload.
 */
export class NormalizingFakeAdapter implements SearchProviderAdapter {
  readonly providerId: string;
  private readonly raw: readonly VendorRawResult[];
  private available: boolean;

  constructor(options: NormalizingFakeAdapterOptions) {
    this.providerId = options.providerId ?? 'vendor';
    this.raw = options.raw;
    this.available = options.available ?? true;
  }

  /** Set the availability reported by {@link isAvailable} (Req 13.9). */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async search(req: WebSearchRequest): Promise<WebSearchResult[]> {
    return normalizeVendorResults(this.raw, req.searchType ?? DEFAULT_SEARCH_TYPE);
  }
}

/**
 * A configuration selector backed by a mutable cell, modelling a runtime config
 * value an administrator can change (Req 13.2).
 *
 * Returns the current provider id from {@link get} and lets a test change it via
 * {@link set} to prove the engine reroutes to the newly configured provider on
 * the next search without any code change.
 */
export function mutableSelector(initial?: string): {
  get: () => string | undefined;
  set: (providerId: string | undefined) => void;
} {
  let current = initial;
  return {
    get: () => current,
    set: (providerId: string | undefined) => {
      current = providerId;
    },
  };
}
