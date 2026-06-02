/**
 * The Unified_Search_Service (Req 29.1-29.7).
 *
 * The service answers a single query across every native content type a user is
 * authorized to reach. {@link UnifiedSearchService.search}:
 *
 *   1. resolves which content types to search — every registered type, or just
 *      the ones named by a content-type filter (Req 29.4), rejecting a filter
 *      that names a type with no registered searcher;
 *   2. fans the query out to each selected {@link ContentTypeSearcher}
 *      concurrently (Req 29.1); a searcher whose backing source is unavailable
 *      (it throws/rejects) is recorded as an unsearched type and excluded from
 *      the results rather than failing the whole query (Req 29.7);
 *   3. drops any candidate whose Organization does not match the principal's
 *      (defense-in-depth tenant isolation, Req 1.2) and any candidate the
 *      injectable {@link UnifiedSearchAuthorizer} rejects (Req 29.2);
 *   4. fuses each survivor's keyword and vector scores into one hybrid relevance
 *      score (Req 29.6), groups the survivors by content type, ranks each group
 *      by non-increasing score (ties broken on id for determinism, Req 29.3),
 *      and bounds each group to the configured per-group top-K;
 *   5. returns the non-empty groups plus the list of content types that could
 *      not be searched (Req 29.7).
 *
 * The per-type searchers and the authorizer are injected ports, so the service
 * is pure fan-out + filter + rank orchestration and fully unit-testable with the
 * in-memory fakes in `./fakes.js` — with no hard dependency on the
 * concurrently-built native modules.
 */

import type { Principal } from '@auxify/types';

import { DuplicateSearcherError, UnknownContentTypeFilterError } from './errors.js';
import { compareByScoreThenId, hybridScore } from './ranking.js';
import {
  DEFAULT_GROUP_LIMIT,
  DEFAULT_KEYWORD_WEIGHT,
  DEFAULT_VECTOR_WEIGHT,
  type ContentTypeSearcher,
  type UnifiedSearchAuthorizer,
  type UnifiedSearchCandidate,
  type UnifiedSearchGroup,
  type UnifiedSearchOptions,
  type UnifiedSearchResult,
  type UnifiedSearchResultItem,
  type UnifiedSearchType,
} from './types.js';

/**
 * Construction-time dependencies for the {@link UnifiedSearchService}.
 *
 * The {@link searchers} and {@link authorizer} are required ports; the weights
 * and per-group limit have defaults. Requiring the authorizer keeps the service
 * honest — it can never skip the per-result access gate (Req 29.2) — while
 * letting tests inject an allow/deny fake.
 */
export interface UnifiedSearchServiceOptions {
  /**
   * One {@link ContentTypeSearcher} per content type to search across (Req 29.1).
   * Two searchers for the same type is a wiring bug ({@link DuplicateSearcherError}).
   */
  searchers: readonly ContentTypeSearcher[];
  /** Decides whether the requesting principal may see each candidate (Req 29.2). */
  authorizer: UnifiedSearchAuthorizer;
  /** The default per-group top-K when a call omits it (defaults to {@link DEFAULT_GROUP_LIMIT}). */
  defaultGroupLimit?: number;
  /** The weight applied to the vector-similarity score (defaults to {@link DEFAULT_VECTOR_WEIGHT}). */
  vectorWeight?: number;
  /** The weight applied to the keyword-overlap score (defaults to {@link DEFAULT_KEYWORD_WEIGHT}). */
  keywordWeight?: number;
}

/** The outcome of fanning the query out to a single content-type searcher. */
interface SearcherOutcome {
  /** The content type the searcher served. */
  type: UnifiedSearchType;
  /** The candidates it returned, or `null` when its source was unavailable (Req 29.7). */
  candidates: UnifiedSearchCandidate[] | null;
}

/**
 * The concrete Unified_Search_Service. Construct it with the per-content-type
 * searcher ports and the authorization port; {@link UnifiedSearchService.search}
 * returns the authorized, grouped, ranked, bounded results for a query plus the
 * content types that could not be searched.
 */
export class UnifiedSearchService {
  private readonly searchers: Map<UnifiedSearchType, ContentTypeSearcher>;
  /** The content types in registration order, for deterministic group ordering. */
  private readonly registrationOrder: UnifiedSearchType[];
  private readonly authorizer: UnifiedSearchAuthorizer;
  private readonly defaultGroupLimit: number;
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;

  constructor(options: UnifiedSearchServiceOptions) {
    this.searchers = new Map();
    this.registrationOrder = [];
    for (const searcher of options.searchers) {
      if (this.searchers.has(searcher.type)) {
        throw new DuplicateSearcherError(searcher.type);
      }
      this.searchers.set(searcher.type, searcher);
      this.registrationOrder.push(searcher.type);
    }
    this.authorizer = options.authorizer;
    this.defaultGroupLimit = options.defaultGroupLimit ?? DEFAULT_GROUP_LIMIT;
    this.vectorWeight = options.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
    this.keywordWeight = options.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT;
  }

  /** The content types this service can search, in registration order. */
  get searchableTypes(): UnifiedSearchType[] {
    return [...this.registrationOrder];
  }

  /**
   * Run a unified search for `query` on behalf of `principal` (Req 29.1-29.7).
   *
   * Fans the query out across the selected content types, filters to what the
   * principal may access (Req 29.2) within their Organization (Req 1.2), fuses
   * keyword and vector relevance (Req 29.6), and returns the results grouped by
   * content type and ranked within each group (Req 29.3), bounded per group, plus
   * the content types whose source was unavailable (Req 29.7).
   *
   * @param query The natural-language search query.
   * @param principal The authenticated actor; scopes the search to their
   *   Organization (Req 1.2) and gates each result by their access (Req 29.2).
   * @param options Optional content-type filter (Req 29.4) and per-group bound.
   * @returns The grouped, ranked result set with any unsearched types named.
   * @throws UnknownContentTypeFilterError When a filter names a content type
   *   with no registered searcher (Req 29.4).
   */
  async search(
    query: string,
    principal: Principal,
    options: UnifiedSearchOptions = {},
  ): Promise<UnifiedSearchResult> {
    const groupLimit = Math.max(0, options.groupLimit ?? this.defaultGroupLimit);
    const typesToSearch = this.resolveTypesToSearch(options.types);

    // (Req 29.1, 29.7) Fan out concurrently; a searcher whose source is
    // unavailable (throws) yields a `null` candidate list so its type is later
    // reported as unsearched rather than failing the whole query.
    const outcomes = await Promise.all(
      typesToSearch.map((type) => this.runSearcher(type, query, principal)),
    );

    const unavailableTypes: UnifiedSearchType[] = [];
    const groups: UnifiedSearchGroup[] = [];

    for (const outcome of outcomes) {
      if (outcome.candidates === null) {
        unavailableTypes.push(outcome.type);
        continue;
      }

      const items = await this.toAuthorizedItems(outcome.type, outcome.candidates, principal);
      if (items.length === 0) {
        // (Req 29.3) Omit a content type that produced no authorized results.
        continue;
      }

      // (Req 29.3) Rank within the group by non-increasing score, then bound to
      // the per-group top-K.
      items.sort(compareByScoreThenId);
      groups.push({ type: outcome.type, items: items.slice(0, groupLimit) });
    }

    return { groups, unavailableTypes };
  }

  /**
   * Resolve the ordered list of content types to search.
   *
   * With no filter (or an empty one) every registered type is searched in
   * registration order (Req 29.1). With a filter, only the named types are
   * searched (Req 29.4) — de-duplicated and re-ordered into registration order
   * for determinism — and a filtered type with no registered searcher is
   * rejected ({@link UnknownContentTypeFilterError}).
   */
  private resolveTypesToSearch(
    filter: readonly UnifiedSearchType[] | undefined,
  ): UnifiedSearchType[] {
    if (filter === undefined || filter.length === 0) {
      return [...this.registrationOrder];
    }
    const requested = new Set<UnifiedSearchType>();
    for (const type of filter) {
      if (!this.searchers.has(type)) {
        throw new UnknownContentTypeFilterError(type, this.registrationOrder);
      }
      requested.add(type);
    }
    return this.registrationOrder.filter((type) => requested.has(type));
  }

  /**
   * Invoke one content type's searcher, scoping its source unavailability
   * (Req 29.7) to a `null` candidate list instead of a thrown error.
   */
  private async runSearcher(
    type: UnifiedSearchType,
    query: string,
    principal: Principal,
  ): Promise<SearcherOutcome> {
    const searcher = this.searchers.get(type);
    if (searcher === undefined) {
      // Unreachable: `type` always comes from the registered set.
      return { type, candidates: [] };
    }
    try {
      const candidates = await searcher.search(query, principal);
      return { type, candidates };
    } catch {
      // (Req 29.7) The source was unavailable; report the type as unsearched.
      return { type, candidates: null };
    }
  }

  /**
   * Filter a content type's candidates to the tenant- and access-authorized
   * survivors and project each into a scored {@link UnifiedSearchResultItem}.
   *
   * Drops any candidate outside the principal's Organization (Req 1.2) before
   * the authorization gate, then keeps only candidates the
   * {@link UnifiedSearchAuthorizer} permits (Req 29.2). Authorization checks run
   * concurrently; the relevance score is the hybrid fusion of the candidate's
   * keyword and vector components (Req 29.6).
   */
  private async toAuthorizedItems(
    type: UnifiedSearchType,
    candidates: readonly UnifiedSearchCandidate[],
    principal: Principal,
  ): Promise<UnifiedSearchResultItem[]> {
    const checks = candidates
      // (Req 1.2) Defense-in-depth: a candidate from another Organization can
      // never survive, regardless of how the searcher scoped its reads.
      .filter((candidate) => candidate.organizationId === principal.organizationId)
      .map(async (candidate) => {
        const allowed = await this.authorizer.authorize(principal, type, candidate);
        return { candidate, allowed };
      });

    const items: UnifiedSearchResultItem[] = [];
    for (const { candidate, allowed } of await Promise.all(checks)) {
      if (!allowed) {
        continue;
      }
      items.push(this.toItem(type, candidate));
    }
    return items;
  }

  /** Project an authorized candidate into a scored result item (Req 29.6). */
  private toItem(
    type: UnifiedSearchType,
    candidate: UnifiedSearchCandidate,
  ): UnifiedSearchResultItem {
    const keywordScore = candidate.keywordScore ?? 0;
    const vectorScore = candidate.vectorScore ?? 0;
    const score = hybridScore(vectorScore, keywordScore, this.vectorWeight, this.keywordWeight);
    return {
      id: candidate.id,
      type,
      title: candidate.title,
      snippet: candidate.snippet,
      score,
      keywordScore,
      vectorScore,
      location: candidate.location,
    };
  }
}
