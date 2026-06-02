/**
 * Web_Search_Engine and Search_Provider_Adapter (Req 13.1-13.6, 13.9).
 *
 * The web-intelligence search boundary: the platform performs every web search
 * through a configuration-selected {@link SearchProviderAdapter} and never
 * references a concrete provider in source (Req 13.1), so swapping the provider
 * is an operational change rather than a code change (Req 13.2).
 *
 * Surface:
 *   - {@link WebSearchEngine} — the engine that resolves the active adapter from
 *     configuration on every search via an injectable {@link ProviderSelector},
 *     gates on the adapter's availability and reports an unavailable provider
 *     (Req 13.9), dispatches the search with the request's type (Req 13.4),
 *     time range (Req 13.5), and include/exclude-domain filters (Req 13.6),
 *     enforces those filters defensively on the returned set (Property 19),
 *     ranks survivors by non-increasing relevance (Req 13.3), and bounds the
 *     result count. The caching that serves identical parameters from cache
 *     (Req 13.8) is the Cache_Manager's concern (task 13.4), and rendering
 *     results with their source links (Req 13.7) is the Output_Renderer's
 *     (task 8.9); both compose this engine.
 *   - {@link SearchProviderAdapter} — the unified, injectable adapter port every
 *     concrete search provider implements, normalizing its vendor payload into
 *     the common {@link WebSearchResult} shape.
 *   - {@link WebSearchRequest} / {@link WebSearchResult} / {@link SearchType} /
 *     {@link TimeRange} — the engine's request/response contract and enums, with
 *     their `DEFAULT_*` and `*_TYPES`/`*_RANGES` constants.
 *   - {@link hostOf} / {@link matchesDomain} / {@link withinTimeRange} /
 *     {@link applyFilters} / {@link rankResults} — the pure normalization,
 *     filtering, and ranking helpers (Req 13.3, 13.5, 13.6).
 *   - {@link ProviderUnavailableError} / {@link NoSearchProviderConfiguredError} —
 *     the typed errors, each projecting to a `provider_unavailable`
 *     {@link import('@auxify/types').PlatformError} (Req 13.9, 46.8).
 *
 * The result/request types here are intentionally named distinctly from the
 * Output_Renderer's `SearchResultItem`/`SearchResultsRenderedBlock` (Req 13.7):
 * those are the transport-facing rendering shapes, while these are the engine's
 * internal contract.
 */

export {
  WebSearchEngine,
  type WebSearchEngineOptions,
  type ProviderSelector,
} from './web-search-engine.js';

export {
  SEARCH_TYPES,
  TIME_RANGES,
  DEFAULT_SEARCH_TYPE,
  DEFAULT_TIME_RANGE,
  DEFAULT_MAX_RESULTS,
  type SearchType,
  type TimeRange,
  type WebSearchRequest,
  type WebSearchResult,
  type SearchProviderAdapter,
  type WebSearchEngineContract,
} from './types.js';

export {
  hostOf,
  matchesDomain,
  withinTimeRange,
  applyFilters,
  rankResults,
  type ActiveFilters,
} from './filtering.js';

export {
  ProviderUnavailableError,
  NoSearchProviderConfiguredError,
  PROVIDER_UNAVAILABLE_CODE,
  NO_PROVIDER_CONFIGURED_CODE,
} from './errors.js';
