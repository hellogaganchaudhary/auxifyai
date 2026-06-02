/**
 * Property-based test for the Unified_Search_Service's graceful degradation —
 * the Unified-Search slice of a cross-cutting platform property.
 *
 *  - Feature: auxify-ai-platform, Property 31 — Native operation degrades
 *    gracefully when optional sources are unavailable (Req 23.9, 29.7, 30.3,
 *    30.4).
 *
 * Req 30.3/30.4 require the native modules to keep serving their core
 * capabilities — chat, knowledge, messaging, documents, and search — without
 * any optional external source, and Req 29.7 specialises this to unified
 * search: when a content source is unavailable during a search, the service
 * returns results from the *available* sources and explicitly lists the content
 * types that could not be searched. The Knowledge_Ingestion_Service slice of
 * the same property (Req 23.9) is covered separately by Property 30/31 in
 * `../knowledge/ingestion-resilience.property.test.ts`; this file pins the
 * search-time degradation contract.
 *
 * The property is checked over >= 100 generated iterations with `fast-check`
 * against the real {@link UnifiedSearchService} wired to the in-memory fakes in
 * `./fakes.js` — no real Knowledge_Hub, Messaging, Document_Management, or
 * Conversation service. Each iteration generates an arbitrary set of
 * content-type searchers, an arbitrary subset flagged unavailable, and an
 * arbitrary candidate population for each, then checks the outcome against an
 * independent oracle: every unavailable type is reported and never grouped,
 * every available type with results still surfaces unaffected, no unavailable
 * source's result ever leaks, and the response stays well-formed no matter how
 * many sources are down (all-down -> empty groups + all types unavailable;
 * none-down -> no unavailable types).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AllowAllAuthorizer,
  FakeContentTypeSearcher,
  TEST_ORG,
  makeCandidate,
  makePrincipal,
} from './fakes.js';
import { UnifiedSearchService } from './unified-search-service.js';
import {
  DEFAULT_GROUP_LIMIT,
  UNIFIED_SEARCH_TYPES,
  type UnifiedSearchType,
} from './types.js';

/** Minimum generated iterations per property (>= 100). */
const NUM_RUNS = 200;

/**
 * The per-content-type configuration one generated scenario assigns to a type:
 * how many candidates its searcher returns (capped well under the default
 * per-group bound so an available type's results are never truncated) and
 * whether its backing source is unavailable for this search.
 */
interface TypeSpec {
  /** The content type this searcher serves. */
  readonly type: UnifiedSearchType;
  /** The relevance scores of each candidate the searcher returns when available. */
  readonly candidates: readonly { keywordScore: number; vectorScore: number }[];
  /** Whether the backing source is unavailable (the searcher throws) for this search. */
  readonly unavailable: boolean;
}

/** A relevance component in `[0, 1]`. */
const scoreArb = fc.double({ min: 0, max: 1, noNaN: true });

/**
 * Generate a scenario: a non-empty subset of the registered content types,
 * each with an independently-generated candidate population and availability
 * flag. Candidate counts stay at or below {@link DEFAULT_GROUP_LIMIT} so an
 * available type's whole population survives the per-group bound, keeping the
 * oracle's "results are unaffected" check exact rather than approximate.
 */
const scenarioArb: fc.Arbitrary<TypeSpec[]> = fc
  .subarray([...UNIFIED_SEARCH_TYPES], { minLength: 1 })
  .chain((types) =>
    fc
      .tuple(
        ...types.map(() =>
          fc.record({
            candidates: fc.array(
              fc.record({ keywordScore: scoreArb, vectorScore: scoreArb }),
              { maxLength: DEFAULT_GROUP_LIMIT },
            ),
            unavailable: fc.boolean(),
          }),
        ),
      )
      .map((perType) =>
        types.map(
          (type, index): TypeSpec => ({
            type,
            candidates: perType[index]!.candidates,
            unavailable: perType[index]!.unavailable,
          }),
        ),
      ),
  );

/** The stable, globally-unique id of the i-th candidate of a content type. */
function candidateId(type: UnifiedSearchType, index: number): string {
  return `${type}#${index}`;
}

/** Build the searcher set for a scenario; an unavailable searcher is toggled to throw (Req 29.7). */
function buildSearchers(specs: readonly TypeSpec[]): FakeContentTypeSearcher[] {
  return specs.map((spec) => {
    const candidates = spec.candidates.map((scores, index) =>
      makeCandidate({
        id: candidateId(spec.type, index),
        organizationId: TEST_ORG,
        keywordScore: scores.keywordScore,
        vectorScore: scores.vectorScore,
      }),
    );
    const searcher = new FakeContentTypeSearcher(spec.type, candidates);
    searcher.setAvailable(!spec.unavailable);
    return searcher;
  });
}

describe('Feature: auxify-ai-platform, Property 31: Native operation degrades gracefully when optional sources are unavailable', () => {
  it('reports every unavailable source and still returns the available ones, unaffected (Req 23.9, 29.7, 30.3, 30.4)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (specs) => {
        const principal = makePrincipal({ organizationId: TEST_ORG });
        const searchers = buildSearchers(specs);
        const service = new UnifiedSearchService({
          searchers,
          authorizer: new AllowAllAuthorizer(),
        });

        const result = await service.search('degradation query', principal);

        // Independent oracle over the generated configuration.
        const unavailableSet = new Set(
          specs.filter((s) => s.unavailable).map((s) => s.type),
        );
        const expectedUnavailable = specs
          .filter((s) => s.unavailable)
          .map((s) => s.type);
        const expectedGroupTypes = specs
          .filter((s) => !s.unavailable && s.candidates.length > 0)
          .map((s) => s.type);

        // (Req 29.7) Every unavailable type is named exactly once, and nothing else is.
        expect([...result.unavailableTypes].sort()).toEqual(
          [...expectedUnavailable].sort(),
        );

        // (Req 29.7, 30.3, 30.4) The surviving groups are exactly the available
        // types that produced results — native operation is unaffected by the
        // sources that are down.
        const groupTypes = result.groups.map((g) => g.type);
        expect([...groupTypes].sort()).toEqual([...expectedGroupTypes].sort());

        // The response is well-formed: group types are distinct and no type is
        // both grouped and reported unavailable.
        expect(new Set(groupTypes).size).toBe(groupTypes.length);
        for (const group of result.groups) {
          expect(unavailableSet.has(group.type)).toBe(false);
          // (Req 29.7) An available type that surfaces is never empty, and its
          // results are exactly the candidates its searcher returned (no bound
          // truncation at these sizes), each carrying its content-type tag.
          expect(group.items.length).toBeGreaterThan(0);
          const spec = specs.find((s) => s.type === group.type)!;
          const expectedIds = spec.candidates.map((_unused, i) =>
            candidateId(group.type, i),
          );
          expect([...group.items.map((i) => i.id)].sort()).toEqual(
            [...expectedIds].sort(),
          );
          for (const item of group.items) {
            expect(item.type).toBe(group.type);
          }
        }

        // (Req 29.7) No result from an unavailable searcher ever leaks into the
        // results, regardless of how relevant it would have been.
        const returnedIds = new Set(
          result.groups.flatMap((g) => g.items.map((i) => i.id)),
        );
        for (const spec of specs) {
          if (!spec.unavailable) {
            continue;
          }
          for (let i = 0; i < spec.candidates.length; i += 1) {
            expect(returnedIds.has(candidateId(spec.type, i))).toBe(false);
          }
        }

        // Boundary shapes the requirement calls out explicitly.
        const allDown = specs.every((s) => s.unavailable);
        const noneDown = specs.every((s) => !s.unavailable);
        if (allDown) {
          // Every source down -> no groups, and every searched type reported.
          expect(result.groups).toEqual([]);
          expect([...result.unavailableTypes].sort()).toEqual(
            [...specs.map((s) => s.type)].sort(),
          );
        }
        if (noneDown) {
          // No source down -> nothing reported as unsearched.
          expect(result.unavailableTypes).toEqual([]);
        }
      }),
      {
        numRuns: NUM_RUNS,
        // Always exercise the documented boundary configurations regardless of
        // random sampling: a single source fully down, a single source healthy,
        // an all-down multi-source set, a none-down multi-source set, and a
        // mixed set where one available type has no candidates.
        examples: [
          [[{ type: 'document', candidates: [{ keywordScore: 0.5, vectorScore: 0.5 }], unavailable: true }]],
          [[{ type: 'document', candidates: [{ keywordScore: 0.5, vectorScore: 0.5 }], unavailable: false }]],
          [
            [
              { type: 'knowledge_page', candidates: [{ keywordScore: 0.9, vectorScore: 0.9 }], unavailable: true },
              { type: 'document', candidates: [{ keywordScore: 0.4, vectorScore: 0.4 }], unavailable: true },
            ],
          ],
          [
            [
              { type: 'knowledge_page', candidates: [{ keywordScore: 0.9, vectorScore: 0.9 }], unavailable: false },
              { type: 'message', candidates: [{ keywordScore: 0.7, vectorScore: 0.2 }], unavailable: false },
            ],
          ],
          [
            [
              { type: 'knowledge_page', candidates: [{ keywordScore: 0.6, vectorScore: 0.6 }], unavailable: false },
              { type: 'document', candidates: [], unavailable: false },
              { type: 'message', candidates: [{ keywordScore: 0.8, vectorScore: 0.8 }], unavailable: true },
            ],
          ],
        ],
      },
    );
  });
});
