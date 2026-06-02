/**
 * Property-based test for below-threshold RAG retrieval signaling.
 *
 * Feature: auxify-ai-platform, Property 33: RAG below-threshold queries return
 * no context with an explicit signal.
 *
 * Design statement (Property 33): "For any query whose best candidate relevance
 * score is below the configured threshold, the RAG_Retriever returns no
 * retrieved context and indicates that no relevant knowledge was found."
 *
 * Validates: Requirements 24.7
 *
 * This test exercises the threshold gate of {@link RagRetriever.retrieve}
 * (task 12.5) in isolation. For an arbitrary population of `knowledge_chunk`
 * vector records — every chunk in the principal's Organization, every chunk
 * carrying complete attribution, and an allow-all authorizer, so neither
 * tenancy (Req 1.2), attribution (Req 24.6), nor authorization (Req 24.3) can
 * remove a candidate — and an arbitrary relevance threshold, the retriever must
 * obey Req 24.7:
 *
 *   - when no candidate's relevance score meets the threshold, return
 *     `found: false`, an empty chunk set, and the explicit
 *     {@link NO_RELEVANT_KNOWLEDGE_MESSAGE} signal;
 *   - otherwise return `found: true` and exactly the candidates whose score is
 *     at or above the threshold (every returned chunk's score >= threshold).
 *
 * The oracle is independent of the retriever's internal scoring math: a
 * *separate* unbounded retrieval at threshold 0 (a top-K larger than the whole
 * population, so the threshold is the only gate that can act) yields the
 * ground-truth ranked scores. The expected outcome for an arbitrary threshold
 * is then derived from those ground-truth scores — the maximum decides
 * found/not-found and the `score >= threshold` subset is the expected returned
 * set — so the test never re-implements the cosine/keyword/hybrid math under
 * test. A large top-K is used for the threshold call too, so only the threshold
 * gate (not the top-K cut, which is Property 18's concern) shapes the result.
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

import { AllowAllChunkAuthorizer } from './fakes.js';
import { RagRetriever } from './rag-retriever.js';
import { NO_RELEVANT_KNOWLEDGE_MESSAGE } from './rag-types.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/** The Organization the querying principal belongs to (all chunks live here). */
const PRINCIPAL_ORG = 'org-1';

/** A small source pool; every source is allowed (the authorizer is allow-all). */
const SOURCE_POOL = ['src-0', 'src-1', 'src-2'] as const;

/** A small vocabulary so generated query/chunk text overlaps vary the keyword score. */
const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'] as const;

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

/** A complete (four-field, all non-empty) attribution for `sourceId` (Req 24.4). */
function completeAttribution(sourceId: string): SourceAttribution {
  return {
    sourceId,
    sourceTitle: `Title ${sourceId}`,
    location: `loc/${sourceId}`,
    link: `https://src/${sourceId}`,
  };
}

/**
 * A 1536-dim embedding whose first half is filled with `g1` and second half
 * with `g2`. Because {@link DeterministicEmbedder} embeds the query as a
 * constant-valued vector, the cosine similarity of such a record reduces to
 * `(g1 + g2) / (sqrt(2) * sqrt(g1^2 + g2^2))`, which sweeps the full `[-1, 1]`
 * range as `(g1, g2)` vary — so chunk vector scores (and thus hybrid scores)
 * spread across `[0, 1]` and straddle any generated threshold, while every
 * embedding still satisfies the Vector_Store's fixed-dimensionality contract
 * (Req 44.2).
 */
function embeddingFrom(g1: number, g2: number): number[] {
  const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(g2);
  const half = EMBEDDING_DIMENSIONS >> 1;
  for (let i = 0; i < half; i++) {
    embedding[i] = g1;
  }
  return embedding;
}

/** A generated chunk: its source, embedding direction, and text words. */
interface ChunkSpec {
  sourceId: string;
  g1: number;
  g2: number;
  words: string[];
}

const chunkSpecArb: fc.Arbitrary<ChunkSpec> = fc.record({
  sourceId: fc.constantFrom(...SOURCE_POOL),
  g1: fc.integer({ min: -3, max: 3 }),
  g2: fc.integer({ min: -3, max: 3 }),
  words: fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 5 }),
});

/** Build the Vector_Store record for the chunk at `index`. */
function toRecord(spec: ChunkSpec, index: number): VectorRecord {
  return {
    id: `chunk-${index}`,
    organizationId: PRINCIPAL_ORG,
    ownerType: 'knowledge_chunk',
    ownerId: `doc-${index}`,
    embedding: embeddingFrom(spec.g1, spec.g2),
    metadata: {
      sourceId: spec.sourceId,
      documentId: `doc-${index}`,
      ordinal: 0,
      text: spec.words.join(' '),
      attribution: completeAttribution(spec.sourceId),
    },
  };
}

/** Stand up a retriever over a fresh vector store holding `records`. */
async function buildRetriever(records: VectorRecord[]): Promise<RagRetriever> {
  const vectors = new InMemoryVectorStore();
  if (records.length > 0) {
    await vectors.upsert(records);
  }
  return new RagRetriever({
    embedder: new DeterministicEmbedder(),
    vectorStore: vectors,
    authorizer: new AllowAllChunkAuthorizer(),
    // The construction-time default is irrelevant here: every call passes an
    // explicit per-query threshold so the property fully controls the gate.
    defaultRelevanceThreshold: 0,
  });
}

/**
 * A threshold spanning all three regimes relative to the hybrid score range
 * `[0, 1]`: within-range values that straddle candidate scores, values above 1
 * (no score can ever meet them), and values at or below 0 (every candidate
 * meets them).
 */
const thresholdArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 6, arbitrary: fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }) },
  { weight: 2, arbitrary: fc.double({ min: 1.0001, max: 5, noNaN: true, noDefaultInfinity: true }) },
  { weight: 2, arbitrary: fc.double({ min: -2, max: 0, noNaN: true, noDefaultInfinity: true }) },
);

/** A scenario: a population of chunks, a query, and a relevance threshold. */
const scenarioArb = fc.record({
  chunks: fc.array(chunkSpecArb, { minLength: 0, maxLength: 15 }),
  queryWords: fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 4 }),
  threshold: thresholdArb,
});

describe('Feature: auxify-ai-platform, Property 33: RAG below-threshold queries return no context with an explicit signal', () => {
  it('returns the explicit no-knowledge signal exactly when no candidate meets the threshold, else only at/above-threshold chunks (Req 24.7)', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const principal = makePrincipal();
        const records = scenario.chunks.map(toRecord);
        const retriever = await buildRetriever(records);
        const query = scenario.queryWords.join(' ');
        // Larger than the whole population, so the top-K cut never fires and the
        // relevance threshold is the only gate that can drop a candidate.
        const bigK = records.length + 5;

        // Ground-truth ranking: threshold 0 keeps every candidate (all hybrid
        // scores are in [0, 1] >= 0), so this returns the full ranked set with
        // the retriever's own scores — the oracle for everything below.
        const ground = await retriever.retrieve(query, principal, {
          topK: bigK,
          minRelevanceScore: 0,
        });
        const groundChunks = ground.found ? ground.chunks : [];

        // The retrieval under test, gated by the arbitrary threshold.
        const result = await retriever.retrieve(query, principal, {
          topK: bigK,
          minRelevanceScore: scenario.threshold,
        });

        // Expected outcome derived purely from the ground-truth scores: the
        // candidates whose score meets the threshold, in ground-truth order.
        const expectedRelevant = groundChunks.filter(
          (chunk) => chunk.score >= scenario.threshold,
        );

        if (expectedRelevant.length === 0) {
          // No candidate meets the threshold (best score < threshold, or the
          // index is empty): explicit no-knowledge signal (Req 24.7).
          expect(result.found).toBe(false);
          expect(result.chunks).toEqual([]);
          expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
        } else {
          // At least one candidate meets the threshold: context is returned and
          // every returned chunk is at or above the threshold (Req 24.7).
          expect(result.found).toBe(true);
          expect(result.message).toBeUndefined();
          for (const chunk of result.chunks) {
            expect(chunk.score).toBeGreaterThanOrEqual(scenario.threshold);
          }
          // The returned set is exactly the at/above-threshold candidates
          // (bigK holds them all, so the threshold is the only filter).
          expect(result.chunks.map((chunk) => chunk.chunkId)).toEqual(
            expectedRelevant.map((chunk) => chunk.chunkId),
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('an empty index always returns the no-knowledge signal, for any query and threshold (Req 24.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 4 }),
        thresholdArb,
        async (queryWords, threshold) => {
          const retriever = await buildRetriever([]);
          const result = await retriever.retrieve(queryWords.join(' '), makePrincipal(), {
            minRelevanceScore: threshold,
          });

          expect(result.found).toBe(false);
          expect(result.chunks).toEqual([]);
          expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a threshold above the score ceiling (> 1) always returns the no-knowledge signal (Req 24.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // At least one candidate so the not-found result is driven by the
        // threshold, not by an empty index.
        fc.array(chunkSpecArb, { minLength: 1, maxLength: 15 }),
        fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 4 }),
        // Hybrid scores live in [0, 1]; any threshold strictly above 1 is
        // unreachable, so no candidate can ever be relevant.
        fc.double({ min: 1.0001, max: 10, noNaN: true, noDefaultInfinity: true }),
        async (chunkSpecs, queryWords, threshold) => {
          const records = chunkSpecs.map(toRecord);
          const retriever = await buildRetriever(records);
          const result = await retriever.retrieve(queryWords.join(' '), makePrincipal(), {
            topK: records.length + 5,
            minRelevanceScore: threshold,
          });

          expect(result.found).toBe(false);
          expect(result.chunks).toEqual([]);
          expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('a threshold at or below 0 with at least one candidate always returns context (Req 24.7)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(chunkSpecArb, { minLength: 1, maxLength: 15 }),
        fc.array(fc.constantFrom(...VOCAB), { minLength: 0, maxLength: 4 }),
        // Every hybrid score is >= 0, so any non-positive threshold is met by
        // every candidate — context is always found.
        fc.double({ min: -5, max: 0, noNaN: true, noDefaultInfinity: true }),
        async (chunkSpecs, queryWords, threshold) => {
          const records = chunkSpecs.map(toRecord);
          const retriever = await buildRetriever(records);
          const result = await retriever.retrieve(queryWords.join(' '), makePrincipal(), {
            topK: records.length + 5,
            minRelevanceScore: threshold,
          });

          expect(result.found).toBe(true);
          expect(result.chunks.length).toBeGreaterThan(0);
          expect(result.chunks.length).toBe(records.length);
          expect(result.message).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
