/**
 * Unified_Search_Service (Req 29.1-29.7).
 *
 * The Unified_Search_Service is the single search across every native content
 * type a user is authorized to access. {@link UnifiedSearchService.search}:
 *
 *   - fans a query out to one injectable {@link ContentTypeSearcher} per content
 *     type — conversations, chat messages, knowledge pages, documents, and
 *     knowledge chunks (Req 29.1) — concurrently, so the service never imports
 *     the concurrently-built Knowledge_Hub_Service, Messaging_Service,
 *     Document_Management_Service, or Conversation_Manager and stays fully
 *     unit-testable with the fakes in `./fakes.js`;
 *   - returns only results the requesting {@link import('@auxify/types').Principal}
 *     may access, via the injectable {@link UnifiedSearchAuthorizer} (Req 29.2),
 *     after dropping any candidate outside the principal's Organization
 *     (defense-in-depth tenant isolation, Req 1.2);
 *   - groups the survivors by content type and ranks each group by
 *     non-increasing relevance, ties broken deterministically on id (Req 29.3),
 *     bounding each group to a configurable per-group top-K;
 *   - honors a content-type filter, searching only the named types (Req 29.4),
 *     and rejecting a filter that names a type with no registered searcher
 *     ({@link UnknownContentTypeFilterError});
 *   - carries the {@link ContentLocation} needed to open each result in its
 *     source module (Req 29.5);
 *   - fuses each result's keyword and vector relevance into one hybrid score via
 *     {@link hybridScore} (Req 29.6); and
 *   - degrades gracefully when a content source is unavailable: that searcher's
 *     type is reported in {@link UnifiedSearchResult.unavailableTypes} while the
 *     available types still return results (Req 29.7, Property 31).
 *
 * Surface:
 *   - {@link UnifiedSearchService} / {@link UnifiedSearchServiceOptions} — the
 *     service and its construction-time ports and tuning.
 *   - {@link ContentTypeSearcher} / {@link UnifiedSearchAuthorizer} — the
 *     injectable per-type search and authorization ports.
 *   - {@link UnifiedSearchType} / {@link UnifiedSearchCandidate} /
 *     {@link UnifiedSearchResultItem} / {@link UnifiedSearchGroup} /
 *     {@link UnifiedSearchResult} / {@link UnifiedSearchOptions} /
 *     {@link ContentLocation} — the request/response contract and enums, with
 *     their `DEFAULT_*` and `UNIFIED_SEARCH_TYPES` constants.
 *   - {@link clamp01} / {@link hybridScore} / {@link compareByScoreThenId} — the
 *     pure scoring and ranking helpers (Req 29.3, 29.6).
 *   - {@link DuplicateSearcherError} / {@link UnknownContentTypeFilterError} —
 *     the typed errors, each projecting to a {@link import('@auxify/types').PlatformError}
 *     (Req 46.8).
 *
 * The result/type names are intentionally distinct (`UnifiedSearch*`,
 * `UnifiedSearchType`) so they never collide with the Web_Search_Engine's
 * `WebSearchResult`/`SearchType` or the Output_Renderer's `SearchResultItem` at
 * the package barrel.
 */

export {
  UnifiedSearchService,
  type UnifiedSearchServiceOptions,
} from './unified-search-service.js';

export {
  UNIFIED_SEARCH_TYPES,
  DEFAULT_GROUP_LIMIT,
  DEFAULT_VECTOR_WEIGHT,
  DEFAULT_KEYWORD_WEIGHT,
  type UnifiedSearchType,
  type ContentLocation,
  type UnifiedSearchCandidate,
  type UnifiedSearchResultItem,
  type UnifiedSearchGroup,
  type UnifiedSearchResult,
  type UnifiedSearchOptions,
  type ContentTypeSearcher,
  type UnifiedSearchAuthorizer,
} from './types.js';

export {
  clamp01,
  hybridScore,
  compareByScoreThenId,
  type Rankable,
} from './ranking.js';

export {
  DuplicateSearcherError,
  UnknownContentTypeFilterError,
  DUPLICATE_SEARCHER_CODE,
  UNKNOWN_CONTENT_TYPE_FILTER_CODE,
} from './errors.js';
