/**
 * Property-based test for the fixed embedding dimensionality invariant.
 *
 * Feature: auxify-ai-platform, Property 56: Embeddings always have the fixed
 * dimensionality.
 *
 * Design statement (Property 56): "For any vector record submitted to the
 * VectorStore, the upsert is accepted if and only if the embedding has exactly
 * 1536 dimensions; records with any other dimensionality are rejected."
 *
 * Validates: Requirements 44.2
 *
 * We exercise the biconditional across arbitrary dimensionalities — including
 * 0, values below 1536, the exact 1536 boundary, and values above 1536 — over
 * both backend implementations of the {@link VectorStore} contract:
 *   - {@link InMemoryVectorStore} (reference fake), and
 *   - {@link PgVectorStore} driven by a fake {@link SqlClient}.
 * No live database is required.
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  InMemoryVectorStore,
  InvalidEmbeddingDimensionError,
  PgVectorStore,
  type SqlClient,
  type VectorOwnerType,
  type VectorRecord,
} from './index.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

const OWNER_TYPES: VectorOwnerType[] = [
  'knowledge_chunk',
  'file_chunk',
  'knowledge_page',
  'document',
  'message',
];

/**
 * Smart dimensionality generator. It biases generation toward the three
 * regions that matter for the biconditional:
 *   - the exact required size (1536),
 *   - sizes strictly below 1536 (including 0, the empty embedding), and
 *   - sizes strictly above 1536.
 * Array lengths are capped well above 1536 so over-sized embeddings are
 * exercised without producing pathologically large allocations.
 */
const dimensionsArb: fc.Arbitrary<number> = fc.oneof(
  // The accepted size — weighted so a healthy fraction of runs are valid.
  { weight: 2, arbitrary: fc.constant(EMBEDDING_DIMENSIONS) },
  // Strictly-smaller sizes, including the empty (0-dimension) embedding.
  { weight: 2, arbitrary: fc.integer({ min: 0, max: EMBEDDING_DIMENSIONS - 1 }) },
  // Strictly-larger sizes.
  { weight: 2, arbitrary: fc.integer({ min: EMBEDDING_DIMENSIONS + 1, max: 2048 }) },
);

/**
 * Generate a fully-formed {@link VectorRecord} whose embedding has the chosen
 * dimensionality. Embedding values are arbitrary finite doubles — they are
 * irrelevant to the dimensionality invariant, so only the length is what the
 * property constrains.
 */
const recordArb: fc.Arbitrary<VectorRecord> = dimensionsArb.chain((dims) =>
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 24 }),
    organizationId: fc.string({ minLength: 1, maxLength: 24 }),
    ownerType: fc.constantFrom(...OWNER_TYPES),
    ownerId: fc.string({ minLength: 1, maxLength: 24 }),
    embedding: fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), {
      minLength: dims,
      maxLength: dims,
    }),
    metadata: fc.constant<Record<string, unknown>>({}),
  }),
);

/** A fake {@link SqlClient} that records every issued statement. */
function fakeSql(): { client: SqlClient; calls: { text: string }[] } {
  const calls: { text: string }[] = [];
  const client: SqlClient = {
    query: vi.fn(async (text: string) => {
      calls.push({ text });
      return { rows: [] };
    }),
  };
  return { client, calls };
}

describe('Feature: auxify-ai-platform, Property 56: Embeddings always have the fixed dimensionality', () => {
  it('InMemoryVectorStore.upsert accepts a record iff its embedding has exactly 1536 dimensions', async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, async (record) => {
        const store = new InMemoryVectorStore();
        const dims = record.embedding.length;

        if (dims === EMBEDDING_DIMENSIONS) {
          // Accepted: the upsert resolves and the record is persisted.
          await store.upsert([record]);
          expect(store.size()).toBe(1);
        } else {
          // Rejected: every non-1536 dimensionality throws and persists nothing.
          await expect(store.upsert([record])).rejects.toBeInstanceOf(
            InvalidEmbeddingDimensionError,
          );
          expect(store.size()).toBe(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('PgVectorStore.upsert accepts a record iff its embedding has exactly 1536 dimensions (no SQL issued on rejection)', async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, async (record) => {
        const { client, calls } = fakeSql();
        const store = new PgVectorStore(client);
        const dims = record.embedding.length;

        if (dims === EMBEDDING_DIMENSIONS) {
          // Accepted: the invariant passes and the backend issues its write.
          await store.upsert([record]);
          expect(calls.length).toBeGreaterThan(0);
        } else {
          // Rejected before any SQL is issued (fail-closed at the boundary).
          await expect(store.upsert([record])).rejects.toBeInstanceOf(
            InvalidEmbeddingDimensionError,
          );
          expect(calls).toHaveLength(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
