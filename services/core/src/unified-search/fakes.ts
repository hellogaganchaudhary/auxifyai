/**
 * Test fakes and builders for the Unified_Search_Service (Req 29.1-29.7).
 *
 * The service depends on two injectable ports — a {@link ContentTypeSearcher}
 * per content type and a {@link UnifiedSearchAuthorizer} — so these fakes
 * implement both deterministically, letting the service's orchestration
 * (fan-out, tenant scoping, authorization filtering, hybrid scoring, grouping,
 * ranking, per-group bounding, and graceful degradation) be unit-tested without
 * any real Knowledge_Hub, Messaging, Document_Management, or Conversation
 * service:
 *
 *  - {@link FakeContentTypeSearcher} returns a seeded candidate set for its
 *    content type, can be toggled unavailable to drive the partial-results path
 *    (Req 29.7), and records every query so a test can assert the service
 *    invoked (or skipped) it.
 *  - {@link AllowAllAuthorizer} authorizes every candidate, for tests that focus
 *    on grouping/ranking/bounding without an access constraint.
 *  - {@link DenyListAuthorizer} authorizes everything except an explicit
 *    deny-list of `type:id` results, modelling a result outside the user's
 *    access (Req 29.2).
 *  - {@link makeCandidate} builds a {@link UnifiedSearchCandidate} with sensible,
 *    deterministic defaults.
 *
 * Import these directly from `./fakes.js` in tests, never from a package barrel.
 */

import type { Principal } from '@auxify/types';

import type {
  ContentLocation,
  ContentTypeSearcher,
  UnifiedSearchAuthorizer,
  UnifiedSearchCandidate,
  UnifiedSearchType,
} from './types.js';

/** The default Organization candidates and principals are built in, for tests. */
export const TEST_ORG = 'org-1' as const;

/**
 * Build a {@link Principal} in {@link TEST_ORG}, with optional overrides.
 *
 * The principal carries the minimum identity the service needs: the acting user
 * and their Organization (used for tenant scoping, Req 1.2). Override any field
 * to model a different user, Organization, or membership.
 */
export function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: TEST_ORG,
    roles: ['standard_user'],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/**
 * Build a {@link UnifiedSearchCandidate} with deterministic defaults; override
 * field-by-field.
 *
 * Defaults place the candidate in {@link TEST_ORG} with a mid-range keyword and
 * vector score and a synthetic {@link ContentLocation}, so a test can seed many
 * candidates and override only the fields it cares about (id, scores,
 * Organization, location).
 */
export function makeCandidate(
  overrides: Partial<UnifiedSearchCandidate> = {},
): UnifiedSearchCandidate {
  const id = overrides.id ?? 'cand-1';
  const location: ContentLocation =
    overrides.location ?? {
      module: 'test',
      resourceType: 'test_resource',
      resourceId: id,
      url: `/test/${id}`,
    };
  return {
    id,
    organizationId: overrides.organizationId ?? TEST_ORG,
    title: overrides.title ?? `Title ${id}`,
    snippet: overrides.snippet ?? `Snippet for ${id}`,
    ...(overrides.keywordScore !== undefined ? { keywordScore: overrides.keywordScore } : {}),
    ...(overrides.vectorScore !== undefined ? { vectorScore: overrides.vectorScore } : {}),
    location,
  };
}

/**
 * A deterministic {@link ContentTypeSearcher} returning a seeded candidate set
 * for one content type.
 *
 * Seed results with {@link setResults}; flip availability with
 * {@link setAvailable} to drive the partial-results path — an unavailable
 * searcher throws, which the service catches and reports as an unsearched type
 * (Req 29.7). Every query is recorded in {@link queries} so a test can assert
 * the service invoked (or, under a content-type filter, skipped) the searcher.
 */
export class FakeContentTypeSearcher implements ContentTypeSearcher {
  readonly type: UnifiedSearchType;
  /** Every query passed to {@link search}, in order. */
  readonly queries: string[] = [];

  private results: UnifiedSearchCandidate[];
  private available: boolean;

  constructor(
    type: UnifiedSearchType,
    results: readonly UnifiedSearchCandidate[] = [],
    available = true,
  ) {
    this.type = type;
    this.results = results.map((result) => ({ ...result }));
    this.available = available;
  }

  /** Replace the seeded candidate set this searcher returns. */
  setResults(results: readonly UnifiedSearchCandidate[]): void {
    this.results = results.map((result) => ({ ...result }));
  }

  /** Set whether the backing source is available; `false` makes {@link search} throw (Req 29.7). */
  setAvailable(available: boolean): void {
    this.available = available;
  }

  async search(query: string, _principal: Principal): Promise<UnifiedSearchCandidate[]> {
    this.queries.push(query);
    if (!this.available) {
      throw new Error(`content source "${this.type}" is unavailable`);
    }
    return this.results.map((result) => ({ ...result }));
  }
}

/**
 * A {@link UnifiedSearchAuthorizer} that authorizes every candidate for every
 * principal (Req 29.2).
 *
 * Useful for tests that exercise grouping, ranking, bounding, and tenant
 * scoping where the access filter should never remove a result. Records every
 * `type:id` it was asked about so a test can assert the gate ran.
 */
export class AllowAllAuthorizer implements UnifiedSearchAuthorizer {
  /** Every `type:id` passed to {@link authorize}, in order. */
  readonly calls: string[] = [];

  authorize(
    _principal: Principal,
    type: UnifiedSearchType,
    candidate: UnifiedSearchCandidate,
  ): boolean {
    this.calls.push(`${type}:${candidate.id}`);
    return true;
  }
}

/**
 * A {@link UnifiedSearchAuthorizer} that authorizes every candidate except an
 * explicit deny-list of `type:id` keys (Req 29.2).
 *
 * Models a result the principal cannot access — a private channel message, a
 * permission-restricted document — that a searcher nonetheless returned: the
 * service must exclude it. The deny-list is keyed by `type:id` so the same id
 * under different content types can be denied independently.
 */
export class DenyListAuthorizer implements UnifiedSearchAuthorizer {
  private readonly denied: Set<string>;

  constructor(deniedKeys: readonly string[] = []) {
    this.denied = new Set(deniedKeys);
  }

  /** Add a `type:id` key to the deny-list. */
  deny(type: UnifiedSearchType, id: string): this {
    this.denied.add(`${type}:${id}`);
    return this;
  }

  authorize(
    _principal: Principal,
    type: UnifiedSearchType,
    candidate: UnifiedSearchCandidate,
  ): boolean {
    return !this.denied.has(`${type}:${candidate.id}`);
  }
}
