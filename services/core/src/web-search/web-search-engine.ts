/**
 * The Web_Search_Engine (Req 13.1-13.6, 13.9).
 *
 * The engine performs every web search through a configuration-selected
 * {@link SearchProviderAdapter} and contains no hardcoded reference to any
 * concrete provider (Req 13.1). It holds a registry of adapters keyed by
 * {@link SearchProviderAdapter.providerId} and a {@link ProviderSelector} that
 * names the active provider; the selector is consulted on *every* search, so an
 * administrator changing the configured provider reroutes subsequent searches
 * without any source change (Req 13.2).
 *
 * Per search the engine: resolves the active adapter from configuration;
 * returns a {@link ProviderUnavailableError} if that adapter reports unavailable
 * or its call fails (Req 13.9); dispatches the search with the request's type
 * (Req 13.4), time range (Req 13.5), and domain filters (Req 13.6) applied;
 * enforces those same filters defensively on the returned results so every
 * survivor satisfies them (Property 19); ranks the survivors by non-increasing
 * relevance (Req 13.3); and bounds the result set to the requested maximum.
 */

import type { Principal } from '@auxify/types';

import { NoSearchProviderConfiguredError, ProviderUnavailableError } from './errors.js';
import { applyFilters, rankResults } from './filtering.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_TYPE,
  DEFAULT_TIME_RANGE,
  type SearchProviderAdapter,
  type WebSearchEngineContract,
  type WebSearchRequest,
  type WebSearchResult,
} from './types.js';

/**
 * Resolves the id of the active search provider from configuration (Req 13.1,
 * 13.2).
 *
 * Modelled as a function so the source of truth — an environment variable, a
 * per-Organization setting row, a feature flag — stays outside the engine, and
 * so the engine re-reads it on every search and reroutes when it changes
 * (Req 13.2). Returning `undefined` (or an empty string) means no provider is
 * configured.
 */
export type ProviderSelector = () => string | undefined;

/** Construction options for a {@link WebSearchEngine}. */
export interface WebSearchEngineOptions {
  /**
   * The available provider adapters. The engine indexes them by
   * {@link SearchProviderAdapter.providerId}; it never references a concrete
   * adapter by name (Req 13.1).
   */
  adapters: readonly SearchProviderAdapter[];
  /** Resolves the active provider id from configuration, re-read per search (Req 13.1, 13.2). */
  selectProvider: ProviderSelector;
  /** Clock for the time-range filter; defaults to {@link Date.now} (Req 13.5). */
  now?: () => number;
}

/**
 * The configuration-driven web search engine (Req 13.1-13.6, 13.9).
 */
export class WebSearchEngine implements WebSearchEngineContract {
  private readonly adapters: Map<string, SearchProviderAdapter>;
  private readonly selectProvider: ProviderSelector;
  private readonly now: () => number;

  constructor(options: WebSearchEngineOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.providerId, adapter]));
    this.selectProvider = options.selectProvider;
    this.now = options.now ?? Date.now;
  }

  /** The ids of every registered provider adapter, in registration order. */
  get registeredProviders(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Run a web search through the configured provider adapter (Req 13.1-13.6,
   * 13.9).
   *
   * @param req The normalized search request.
   * @param _principal The actor issuing the search; reserved for per-user
   *   attribution/budgeting (Req 22) and unused by the current implementation.
   * @returns Filtered, relevance-ranked, bounded results (Req 13.3, 13.5, 13.6).
   * @throws NoSearchProviderConfiguredError When no provider is configured (Req 13.1).
   * @throws ProviderUnavailableError When the configured adapter is unavailable (Req 13.9).
   */
  async search(req: WebSearchRequest, _principal: Principal): Promise<WebSearchResult[]> {
    const adapter = this.resolveAdapter();

    let available: boolean;
    try {
      available = await adapter.isAvailable();
    } catch (error) {
      // An availability probe that itself fails means the provider is unusable.
      throw new ProviderUnavailableError(adapter.providerId, describeCause(error));
    }
    if (!available) {
      throw new ProviderUnavailableError(adapter.providerId);
    }

    const searchType = req.searchType ?? DEFAULT_SEARCH_TYPE;
    const timeRange = req.timeRange ?? DEFAULT_TIME_RANGE;
    const maxResults = normalizeMaxResults(req.maxResults);

    let raw: WebSearchResult[];
    try {
      raw = await adapter.search({ ...req, searchType, timeRange, maxResults });
    } catch (error) {
      // A failed provider call is reported uniformly as provider-unavailable,
      // identifying the provider (Req 13.9), never leaking provider internals.
      throw new ProviderUnavailableError(adapter.providerId, describeCause(error));
    }

    // Defense-in-depth: enforce the active filters on the returned set so every
    // result satisfies the time-range and domain constraints regardless of how
    // faithfully the adapter applied them (Req 13.5, 13.6, Property 19).
    const filtered = applyFilters(raw, {
      ...(req.includeDomains !== undefined ? { includeDomains: req.includeDomains } : {}),
      ...(req.excludeDomains !== undefined ? { excludeDomains: req.excludeDomains } : {}),
      timeRange,
      now: this.now(),
    });

    return rankResults(filtered).slice(0, maxResults);
  }

  /**
   * Resolve the active provider adapter from configuration (Req 13.1, 13.2).
   *
   * @throws NoSearchProviderConfiguredError When no provider is selected/registered.
   * @throws ProviderUnavailableError When the selected provider id is not registered.
   */
  private resolveAdapter(): SearchProviderAdapter {
    if (this.adapters.size === 0) {
      throw new NoSearchProviderConfiguredError();
    }
    const providerId = this.selectProvider();
    if (providerId === undefined || providerId.trim().length === 0) {
      throw new NoSearchProviderConfiguredError();
    }
    const adapter = this.adapters.get(providerId);
    if (adapter === undefined) {
      throw new ProviderUnavailableError(providerId, 'provider not registered');
    }
    return adapter;
  }
}

/** Clamp a requested result limit to a positive integer, defaulting when absent/invalid. */
function normalizeMaxResults(maxResults: number | undefined): number {
  if (maxResults === undefined || !Number.isFinite(maxResults)) {
    return DEFAULT_MAX_RESULTS;
  }
  const floored = Math.floor(maxResults);
  return floored > 0 ? floored : DEFAULT_MAX_RESULTS;
}

/** Produce a safe, secret-free description of a thrown cause for error detail. */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'provider call failed';
}
