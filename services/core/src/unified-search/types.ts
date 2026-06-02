/**
 * Domain types and injectable ports for the Unified_Search_Service
 * (Req 29.1-29.7).
 *
 * The Unified_Search_Service answers a single query across every native content
 * type a user can reach — conversations, chat messages, knowledge pages,
 * documents, and knowledge chunks (Req 29.1) — and returns the matches grouped
 * by content type and ranked by relevance within each group (Req 29.3). It
 * never owns the per-type indexes: each content type is reached through a narrow
 * injectable {@link ContentTypeSearcher} port, and authorization is a separate
 * injectable {@link UnifiedSearchAuthorizer} port, so the service is pure
 * fan-out + filter + rank orchestration and fully unit-testable with the
 * in-memory fakes in `./fakes.js` — with no hard dependency on the
 * concurrently-built Knowledge_Hub_Service, Messaging_Service,
 * Document_Management_Service, or Conversation_Manager.
 *
 * Every type here is named distinctly (`UnifiedSearch*`, `UnifiedSearchType`) so
 * it never collides with the Web_Search_Engine's `WebSearchResult`/`SearchType`
 * or the Output_Renderer's `SearchResultItem` at the package barrel.
 */

import type { Principal } from '@auxify/types';

/**
 * The content types the Unified_Search_Service searches across (Req 29.1).
 *
 * Each value names a native module's searchable content. A
 * {@link ContentTypeSearcher} is registered per type; the union is the closed
 * set the service fans out to, groups by (Req 29.3), and filters on (Req 29.4).
 */
export type UnifiedSearchType =
  | 'conversation'
  | 'message'
  | 'knowledge_page'
  | 'document'
  | 'knowledge_chunk';

/** Every {@link UnifiedSearchType}, for iteration, validation, and test generators. */
export const UNIFIED_SEARCH_TYPES: readonly UnifiedSearchType[] = [
  'conversation',
  'message',
  'knowledge_page',
  'document',
  'knowledge_chunk',
] as const;

/** The default maximum number of results returned per content-type group (Req 29.3). */
export const DEFAULT_GROUP_LIMIT = 10 as const;

/** The default weight applied to the vector-similarity component of the hybrid score (Req 29.6). */
export const DEFAULT_VECTOR_WEIGHT = 0.5 as const;

/** The default weight applied to the keyword-overlap component of the hybrid score (Req 29.6). */
export const DEFAULT_KEYWORD_WEIGHT = 0.5 as const;

/**
 * The location needed to open a result in its source module (Req 29.5).
 *
 * When a user selects a result, the client opens the underlying resource in the
 * module that owns it; this carries exactly the address it needs. {@link module}
 * names the owning native module, {@link resourceType} and {@link resourceId}
 * identify the resource, and {@link url} is the relative deep-link path the web
 * client navigates to.
 */
export interface ContentLocation {
  /** The native module that owns the resource (e.g. `knowledge_hub`, `messaging`). */
  module: string;
  /** The owning resource's kind, as the source module models it. */
  resourceType: string;
  /** The owning resource's stable id within its module. */
  resourceId: string;
  /** A relative deep-link path the web client navigates to (Req 29.5). */
  url: string;
}

/**
 * A single candidate a {@link ContentTypeSearcher} returns for a query, before
 * the service applies authorization, hybrid re-scoring, ranking, and the
 * group bound.
 *
 * The searcher supplies the relevance signals it has — a keyword-overlap score
 * and/or a vector-similarity score, each in `[0, 1]` — and the service fuses
 * them into the final hybrid score (Req 29.6). The {@link organizationId} is
 * carried for defense-in-depth tenant scoping (Req 1.2): the service drops any
 * candidate whose Organization does not match the requesting principal's, even
 * though a correct searcher already scopes its own reads.
 */
export interface UnifiedSearchCandidate {
  /** The result's stable id within its content type (used as the ranking tie-break). */
  id: string;
  /** The Organization that owns the result (defense-in-depth for Req 1.2). */
  organizationId: string;
  /** A short human-readable title for the result. */
  title: string;
  /** A short snippet/summary of the matching content. */
  snippet: string;
  /** The keyword-overlap relevance score in `[0, 1]`, when the searcher computes one (Req 29.6). */
  keywordScore?: number;
  /** The vector-similarity relevance score in `[0, 1]`, when the searcher computes one (Req 29.6). */
  vectorScore?: number;
  /** The location needed to open the result in its source module (Req 29.5). */
  location: ContentLocation;
}

/**
 * A single ranked result in a grouped unified-search response (Req 29.3, 29.5,
 * 29.6).
 *
 * Carries the final fused relevance {@link score} the result was ranked by, its
 * content {@link type}, and the {@link ContentLocation} the client opens on
 * selection. The keyword and vector components are retained for transparency and
 * client-side re-ranking.
 */
export interface UnifiedSearchResultItem {
  /** The result's stable id within its content type. */
  id: string;
  /** The content type this result belongs to (Req 29.3). */
  type: UnifiedSearchType;
  /** A short human-readable title for the result. */
  title: string;
  /** A short snippet/summary of the matching content. */
  snippet: string;
  /** The combined hybrid relevance score in `[0, 1]` the result was ranked by (Req 29.6). */
  score: number;
  /** The keyword-overlap component of {@link score} (Req 29.6). */
  keywordScore: number;
  /** The vector-similarity component of {@link score} (Req 29.6). */
  vectorScore: number;
  /** The location needed to open the result in its source module (Req 29.5). */
  location: ContentLocation;
}

/**
 * The ranked, bounded results for a single content type (Req 29.3).
 *
 * {@link items} are ordered by non-increasing {@link UnifiedSearchResultItem.score}
 * and never exceed the per-group limit. A group with no surviving results is
 * omitted from the response rather than included empty.
 */
export interface UnifiedSearchGroup {
  /** The content type this group holds (Req 29.3). */
  type: UnifiedSearchType;
  /** The ranked results, best-first and bounded by the per-group limit (Req 29.3). */
  items: UnifiedSearchResultItem[];
}

/**
 * The complete unified-search response (Req 29.3, 29.7).
 *
 * {@link groups} holds one {@link UnifiedSearchGroup} per content type that
 * produced at least one authorized result, each internally ranked.
 * {@link unavailableTypes} names the content types whose searcher was
 * unavailable during the search, so the caller can show partial results and
 * indicate what could not be searched (Req 29.7); it is empty when every
 * searched type responded.
 */
export interface UnifiedSearchResult {
  /** The non-empty, internally-ranked groups, one per content type (Req 29.3). */
  groups: UnifiedSearchGroup[];
  /** The content types that could not be searched because their source was unavailable (Req 29.7). */
  unavailableTypes: UnifiedSearchType[];
}

/**
 * Per-query options for a unified search.
 *
 * {@link types} is the content-type filter (Req 29.4): when present and
 * non-empty, the service searches only those types and ignores all others.
 * {@link groupLimit} overrides the per-group top-K bound for this query.
 */
export interface UnifiedSearchOptions {
  /** Restrict the search to these content types; omitted/empty searches all (Req 29.4). */
  types?: readonly UnifiedSearchType[];
  /** The maximum number of results per content-type group (Req 29.3); defaults to {@link DEFAULT_GROUP_LIMIT}. */
  groupLimit?: number;
}

/**
 * The injectable port over a single content type's index (Req 29.1).
 *
 * Each native module (Knowledge_Hub, Messaging, Document_Management,
 * Conversation_Manager) exposes its searchable content to the
 * Unified_Search_Service through one of these. The service fans a query out to
 * every registered searcher concurrently, so a searcher must scope its own
 * reads to the principal's Organization (Req 1.2) and return only matches the
 * principal could plausibly see — the service then applies the
 * {@link UnifiedSearchAuthorizer} as a second, authoritative gate (Req 29.2).
 *
 * Modelling each content type as a narrow port keeps the service independent of
 * the concurrently-built module implementations and fully unit-testable with
 * fakes. A searcher signals that its backing source is unavailable by throwing
 * (or returning a rejected promise); the service catches that and reports the
 * type as unsearched rather than failing the whole query (Req 29.7).
 */
export interface ContentTypeSearcher {
  /** The content type this searcher serves; each registered searcher has a distinct type. */
  readonly type: UnifiedSearchType;

  /**
   * Search this content type for `query` on behalf of `principal`.
   *
   * @param query The natural-language search query.
   * @param principal The authenticated actor; scope reads to their Organization (Req 1.2).
   * @returns The candidate matches, in any order; the service re-scores, ranks,
   *   and bounds them.
   * @throws When the backing source is unavailable, so the service can report
   *   this content type as unsearched (Req 29.7).
   */
  search(query: string, principal: Principal): Promise<UnifiedSearchCandidate[]>;
}

/**
 * The port that decides whether a {@link Principal} may see a given candidate
 * (Req 29.2).
 *
 * The Unified_Search_Service excludes any candidate the authorizer rejects, so
 * a result outside the user's access — a private channel message, a
 * permission-restricted document or page — never surfaces, regardless of what a
 * searcher returned. Modelling authorization as a port keeps the service
 * independent of Access_Control and the per-module permission models and lets
 * tests inject a deterministic decision. Tenant isolation (Req 1.2) is enforced
 * separately and earlier by the per-Organization candidate check; this port
 * adds the finer-grained per-resource access on top (Req 29.2).
 */
export interface UnifiedSearchAuthorizer {
  /**
   * Decide whether `principal` may see `candidate` of content type `type`.
   *
   * @param principal The authenticated actor issuing the query.
   * @param type The candidate's content type.
   * @param candidate The candidate under consideration.
   * @returns `true` to keep the candidate, `false` to exclude it (Req 29.2).
   */
  authorize(
    principal: Principal,
    type: UnifiedSearchType,
    candidate: UnifiedSearchCandidate,
  ): boolean | Promise<boolean>;
}
