/**
 * Domain types and the injectable adapter port for the Web_Search_Engine and
 * Search_Provider_Adapter (Req 13.1-13.6, 13.9).
 *
 * The Web_Search_Engine performs every web search through a
 * configuration-selected {@link SearchProviderAdapter} and contains no
 * hardcoded reference to any specific search provider (Req 13.1). The active
 * provider is resolved from configuration on every search, so changing the
 * configured provider reroutes subsequent searches without any source change
 * (Req 13.2). Each adapter normalizes its vendor's raw payload into the common
 * {@link WebSearchResult} shape so the rest of the platform — the Chat_Service,
 * the Agent_Runtime's web tools, the Output_Renderer — never depends on a
 * single vendor.
 *
 * The result/request shapes here are the engine's internal contract; the
 * Output_Renderer's `search_results` block (Req 13.7) is a separate, transport-
 * facing rendering type, so these names are intentionally distinct
 * ({@link WebSearchRequest} / {@link WebSearchResult}) and never collide with
 * the rendering layer's `SearchResultItem`.
 */

import type { Principal } from '@auxify/types';

/**
 * The kinds of web search the engine supports (Req 13.4).
 *
 * `general` is the default when a request omits a type. `images` returns image
 * results; the remaining types bias the underlying provider toward news,
 * academic, or code-oriented sources.
 */
export type SearchType = 'general' | 'news' | 'academic' | 'code' | 'images';

/** Every {@link SearchType}, for iteration, validation, and test generators. */
export const SEARCH_TYPES: readonly SearchType[] = [
  'general',
  'news',
  'academic',
  'code',
  'images',
] as const;

/** The default search type applied when a {@link WebSearchRequest} omits one. */
export const DEFAULT_SEARCH_TYPE: SearchType = 'general';

/**
 * A recency window a search may restrict results to (Req 13.5).
 *
 * `all` (the default) applies no time restriction; the finite windows restrict
 * returned results to those published within the trailing day/week/month/year.
 */
export type TimeRange = 'day' | 'week' | 'month' | 'year' | 'all';

/** Every {@link TimeRange}, for iteration, validation, and test generators. */
export const TIME_RANGES: readonly TimeRange[] = ['day', 'week', 'month', 'year', 'all'] as const;

/** The default time range applied when a {@link WebSearchRequest} omits one. */
export const DEFAULT_TIME_RANGE: TimeRange = 'all';

/** The default maximum number of results returned when a request omits a limit. */
export const DEFAULT_MAX_RESULTS = 10 as const;

/**
 * A single normalized web search request.
 *
 * `searchType` selects the result kind (Req 13.4); `timeRange` restricts
 * recency (Req 13.5); `includeDomains`/`excludeDomains` constrain the result
 * hosts (Req 13.6); `maxResults` bounds the returned set. Every field except
 * `query` is optional and falls back to the engine's defaults.
 */
export interface WebSearchRequest {
  /** The natural-language search query. */
  query: string;
  /** The kind of search to perform; defaults to {@link DEFAULT_SEARCH_TYPE} (Req 13.4). */
  searchType?: SearchType;
  /** Restrict results to this recency window; defaults to {@link DEFAULT_TIME_RANGE} (Req 13.5). */
  timeRange?: TimeRange;
  /** Keep only results whose host matches one of these domains (Req 13.6). */
  includeDomains?: string[];
  /** Drop any result whose host matches one of these domains (Req 13.6). */
  excludeDomains?: string[];
  /** The maximum number of results to return; defaults to {@link DEFAULT_MAX_RESULTS}. */
  maxResults?: number;
}

/**
 * A single normalized web search result.
 *
 * Every {@link SearchProviderAdapter} maps its vendor's raw payload into this
 * shape, so callers consume one stable result type regardless of provider. The
 * {@link score} is a relevance score in `[0, 1]` (higher is more relevant) used
 * to rank results (Req 13.3); {@link publishedAt} carries the result's
 * publication time when the provider supplies one, enabling the engine's
 * time-range restriction (Req 13.5).
 */
export interface WebSearchResult {
  /** The result title. */
  title: string;
  /** The result's absolute URL. */
  url: string;
  /** A short snippet/summary of the result. */
  snippet: string;
  /** Relevance score in `[0, 1]`; higher ranks earlier (Req 13.3). */
  score: number;
  /** The result's publication timestamp (ISO-8601), when the provider supplies one. */
  publishedAt?: string;
  /** The originating site/source name, when available. */
  source?: string;
  /** The search type this result was retrieved for (Req 13.4). */
  searchType: SearchType;
}

/**
 * The configuration-selected boundary over a single search vendor (Req 13.1).
 *
 * Every concrete provider (Serper, Brave, Tavily, Exa, …) implements this one
 * interface. The {@link WebSearchEngine} holds a set of adapters and selects
 * one by configuration; it never references a concrete adapter by name, so
 * onboarding or swapping a provider is a configuration change, not a code
 * change (Req 13.1, 13.2).
 */
export interface SearchProviderAdapter {
  /** Stable provider identifier, e.g. `serper`, `brave`, `tavily`. */
  readonly providerId: string;

  /**
   * Execute a search and return results ranked by the provider's own relevance
   * (Req 13.3). The adapter is responsible for translating {@link WebSearchRequest}
   * into its vendor's query shape — including the search type (Req 13.4), time
   * range (Req 13.5), and domain filters (Req 13.6) — and for normalizing the
   * vendor's payload into {@link WebSearchResult} entries.
   */
  search(req: WebSearchRequest): Promise<WebSearchResult[]>;

  /**
   * Report whether the provider is currently usable. The engine consults this
   * before dispatching a search and returns a provider-unavailable error when
   * it is `false` (Req 13.9).
   */
  isAvailable(): Promise<boolean>;
}

/**
 * The engine's public contract (Req 13.1-13.6, 13.9).
 *
 * {@link WebSearchEngine} is the concrete implementation; this interface
 * documents the surface the rest of the platform depends on. `principal` is
 * carried for future per-user attribution/budgeting (Req 22) and is reserved
 * by the current implementation.
 */
export interface WebSearchEngineContract {
  /** Run a web search through the configured provider adapter. */
  search(req: WebSearchRequest, principal: Principal): Promise<WebSearchResult[]>;
}
