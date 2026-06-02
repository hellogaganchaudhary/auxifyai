/**
 * Property-based test for authorized, ranked, bounded RAG retrieval.
 *
 * Feature: auxify-ai-platform, Property 18: Search and retrieval return only
 * authorized items, ranked by relevance.
 *
 * Design statement (Property 18): "For any query issued against conversations,
 * messages, knowledge chunks, knowledge collections, or unified content, every
 * returned item is one the requesting user is authorized to access, results are
 * ordered by non-increasing relevance score (and grouped by content type for
 * unified search), and the retrieved set never exceeds the configured top-K
 * limit."
 *
 * Validates: Requirements 5.5, 24.1, 24.2, 24.3, 25.2, 27.6, 29.1, 29.2, 29.3
 *
 * This test exercises the slice of Property 18 owned by the RAG_Retriever
 * (task 12.5): for an arbitrary population of `knowledge_chunk` vector records
 * (varied embeddings and sources, every chunk carrying complete attribution so
 * the attribution gate is held constant), an arbitrary authorizer allow-list of
 * source ids, and an arbitrary top-K, {@link RagRetriever.retrieve} must:
 *
 *   - return only chunks the principal is authorized to access — every returned
 *     chunk's source id is in the allow-list (Req 24.3, 25.2);
 *   - never cross an Organization boundary — no returned chunk belongs to a
 *     different Organization (Req 1.2);
 *   - never exceed the configured top-K (Req 24.2);
 *   - return exactly the highest-scored authorized, attributed chunks, ordered
 *     by non-increasing relevance score (Req 24.1, 24.2).
 *
 * The oracle is independent of the retriever's internal scoring: the eligible
 * set S (organization-scoped, allow-listed, completely-attributed chunks) is
 * computed directly from the generated population, and the expected top-K is
 * derived from a *separate* full-ranking retrieval (top-K larger than the whole
 * population) used as ground truth for the ordering and the cut. The bounded
 * call must then return precisely the top-K prefix of that full ranking, so the
 * test verifies authorization, ranking, and bounding together without
 * re-implementing the cosine/keyword math under test.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Principal, SourceAttribution } from '@auxify/types';

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import {
  EMBEDDING_DIMENSIONS,
  InMemoryVectorStore,
  type VectorRecord,
} from '../storage/index.js';

import { SourceScopedChunkAuthorizer } from './fakes.js';
import { RagRetriever } from './rag-retriever.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/** The Organization the querying principal belongs to. */
const PRINCIPAL_ORG = 'org-principal';
/** A distinct Organization whose chunks must never surface (Req 1.2). */
const FOREIGN_ORG = 'org-foreign';

/** A small pool of source ids so allow-lists meaningfully include and exclude sources. */
const SOURCE_POOL = ['src-0', 'src-1', 'src-2', 'src-3', 'src-4'] as const;

/** A small vocabulary so generated query/chunk text overlaps vary the keyword score. */
const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'] as const;

/** Build a principal in {@link PRINCIPAL_ORG}. */
function makePrincipal(): Principal {
  return {
    userId: 'user-1',
    organizationId: PRINCIPAL_ORG,
    roles: ['standard_user'],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
  };
}

/** A complete (four-field, all non-empty) attribution for `sourceId`. */
function completeAttribution(sourceId: string): SourceAttribution {
  return {
    sourceId,
    sourceTitle: `Title ${sourceId}`,
    location: `loc/${sourceId}`,
    link: `https://src/${sourceId}`,
  };
}

/**
 * A 1536-dim embedding whose first two components carry the generated direction
 * and the remainder are zero. Varying `(x, y)` varies the chunk's cosine
 * similarity to the constant-valued query embedding, so vector scores spread
 * across the population while every embedding still satisfies the Vector_Store's
 * fixed-dimensionality contract (Req 44.2).
 */
function embeddingFrom(x: number, y: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  embedding[0] = x;
  embedding[1] = y;
  return embedding;
}

/** A generated chunk: its source, embedding direction, text, and owning Organization. */
interface ChunkSpec {
  sourceId: string;
  ex: number;
  ey: number;
  words: string[];
  foreign: boolean;
}

const chunkSpecArb: fc.Arbitrary<ChunkSpec> = fc.record({
  sourceId: fc.constantFrom(...SOURCE_POOL),
  ex: fc.integer({ min: -6, max: 6 }),
  ey: fc.integer({ min: -6, max: 6 }),
  words: fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 6 }),
  // ~1/4 of chunks belong to a foreign Organization and must never be returned.
  foreign: fc.oneof(
    { weight: 3, arbitrary: fc.constant(false) },
    { weight: 1, arbitrary: fc.constant(true) },
  ),
});

/** A scenario: a population of chunks, an authorizer allow-list, a query, and a top-K. */
const scenarioArb = fc.record({
  chunks: fc.array(chunkSpecArb, { minLength: 0, maxLength: 20 }),
  // An arbitrary subset of the source pool the principal may access (Req 24.3).
  allowed: fc.subarray([...SOURCE_POOL]),
  // The query terms; may be empty (no keyword contribution).
  queryWords: fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 5 }),
  // A top-K spanning zero, within-population, and beyond-population sizes (Req 24.2).
  topK: fc.integer({ min: 0, max: 22 }),
});

/** Build the Vector_Store record for the chunk at `index`. */
function toRecord(spec: ChunkSpec, index: number): VectorRecord {
  return {
    id: `chunk-${index}`,
    organizationId: spec.foreign ? FOREIGN_ORG : PRINCIPAL_ORG,
    ownerType: 'knowledge_chunk',
    ownerId: `doc-${index}`,
    embedding: embeddingFrom(spec.ex, spec.ey),
    metadata: {
      sourceId: spec.sourceId,
      documentId: `doc-${index}`,
      ordinal: 0,
      text: spec.words.join(' '),
      attribution: completeAttribution(spec.sourceId),
    },
  };
}

describe('Feature: auxify-ai-platform, Property 18: Search and retrieval return only authorized items, ranked by relevance', () => {
  it('returns only authorized, in-Organization chunks, bounded by top-K and ranked by non-increasing relevance', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const principal = makePrincipal();
        const allowedSet = new Set<string>(scenario.allowed);
        const records = scenario.chunks.map(toRecord);

        // Independent oracle inputs derived directly from the population:
        // the foreign-Organization chunk ids (must never appear) and the
        // eligible set S = in-Organization AND allow-listed (every chunk has
        // complete attribution by construction, so the attribution gate is held
        // constant and S is exactly the authorized, in-org population).
        const foreignIds = new Set(
          scenario.chunks.flatMap((c, i) => (c.foreign ? [`chunk-${i}`] : [])),
        );
        const eligible = new Set(
          scenario.chunks.flatMap((c, i) =>
            !c.foreign && allowedSet.has(c.sourceId) ? [`chunk-${i}`] : [],
          ),
        );

        const vectors = new InMemoryVectorStore();
        if (records.length > 0) {
          await vectors.upsert(records);
        }
        const retriever = new RagRetriever({
          embedder: new DeterministicEmbedder(),
          vectorStore: vectors,
          authorizer: new SourceScopedChunkAuthorizer(scenario.allowed),
          // Threshold 0 keeps every eligible chunk relevant, so this property
          // isolates authorization, ranking, and the top-K bound (the
          // below-threshold signal is Property 33's concern).
          defaultRelevanceThreshold: 0,
        });

        const query = scenario.queryWords.join(' ');

        // Ground-truth full ranking: a top-K larger than the whole population so
        // every eligible chunk is returned, ranked by the retriever's own score.
        const full = await retriever.retrieve(query, principal, {
          topK: records.length + 5,
          minRelevanceScore: 0,
        });
        // The bounded retrieval under test.
        const bounded = await retriever.retrieve(query, principal, {
          topK: scenario.topK,
          minRelevanceScore: 0,
        });

        const fullIds = full.chunks.map((c) => c.chunkId);
        const boundedIds = bounded.chunks.map((c) => c.chunkId);

        // --- Full ranking is exactly the eligible set (authorization + tenancy) ---
        // Only authorized, in-Organization, attributed chunks are returned, and
        // none are dropped (Req 24.3, 25.2, 1.2).
        expect(new Set(fullIds)).toEqual(eligible);
        expect(full.found).toBe(eligible.size > 0);
        // Every returned chunk is authorized and belongs to the principal's Org.
        for (const chunk of full.chunks) {
          expect(allowedSet.has(chunk.attribution.sourceId)).toBe(true);
          expect(foreignIds.has(chunk.chunkId)).toBe(false);
          // Complete attribution travels with every returned chunk (Req 24.4).
          expect(chunk.attribution.sourceId).not.toBe('');
          expect(chunk.attribution.sourceTitle).not.toBe('');
          expect(chunk.attribution.location).not.toBe('');
          expect(chunk.attribution.link).not.toBe('');
        }
        // Non-increasing relevance order across the full ranking (Req 24.2).
        for (let i = 1; i < full.chunks.length; i++) {
          expect(full.chunks[i - 1]!.score).toBeGreaterThanOrEqual(full.chunks[i]!.score);
        }

        // --- Bounded retrieval: authorized, top-K, ranked ---
        // Never exceeds top-K (Req 24.2).
        expect(boundedIds.length).toBeLessThanOrEqual(scenario.topK);
        expect(boundedIds.length).toBe(Math.min(scenario.topK, eligible.size));
        expect(bounded.found).toBe(eligible.size > 0);
        // Every returned chunk is authorized and in the principal's Organization.
        for (const chunk of bounded.chunks) {
          expect(allowedSet.has(chunk.attribution.sourceId)).toBe(true);
          expect(eligible.has(chunk.chunkId)).toBe(true);
          expect(foreignIds.has(chunk.chunkId)).toBe(false);
        }
        // Non-increasing relevance order across the bounded result (Req 24.2).
        for (let i = 1; i < bounded.chunks.length; i++) {
          expect(bounded.chunks[i - 1]!.score).toBeGreaterThanOrEqual(bounded.chunks[i]!.score);
        }

        // --- Exactly the highest-scored authorized chunks (Req 24.1, 24.2) ---
        // The bounded set is precisely the top-K prefix of the full ranking, so
        // no lower-scored chunk is ever returned ahead of a higher-scored one.
        expect(boundedIds).toEqual(fullIds.slice(0, scenario.topK));

        // Independent restatement of the cut: every excluded eligible chunk
        // scores no higher than the lowest-scored included chunk.
        if (bounded.chunks.length > 0) {
          const minIncluded = Math.min(...bounded.chunks.map((c) => c.score));
          const includedIds = new Set(boundedIds);
          for (const chunk of full.chunks) {
            if (!includedIds.has(chunk.chunkId)) {
              expect(chunk.score).toBeLessThanOrEqual(minIncluded);
            }
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
