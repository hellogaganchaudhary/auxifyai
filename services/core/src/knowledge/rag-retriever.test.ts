/**
 * Unit tests for the RAG_Retriever (Req 24.1-24.7).
 *
 * These exercise the full retrieval surface against the in-memory fakes and the
 * spec-faithful {@link InMemoryVectorStore} — no real embedding model, database,
 * or authorization service:
 *
 *  - query embedding + hybrid (vector + keyword) retrieval (Req 24.1);
 *  - re-ranking and the top-K bound (Req 24.2);
 *  - permission filtering that never returns an unauthorized chunk (Req 24.3),
 *    including tenant scoping — a query never returns another Organization's
 *    chunks (Req 1.2);
 *  - complete source attribution on every returned chunk (Req 24.4);
 *  - exclusion of chunks lacking complete attribution (Req 24.6);
 *  - below-threshold queries returning no context with an explicit signal
 *    (Req 24.7).
 *
 * The chunks are written through the real {@link KnowledgeIngestionService} so
 * the retriever reads exactly the `knowledge_chunk` records ingestion produces,
 * proving the write-then-retrievable contract (Property 28) end to end.
 */

import { describe, expect, it } from 'vitest';

import type { Principal, SourceAttribution } from '@auxify/types';

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import {
  EMBEDDING_DIMENSIONS,
  InMemoryVectorStore,
  type VectorRecord,
} from '../storage/index.js';

import {
  AllowAllChunkAuthorizer,
  FakeSourceFetcher,
  InMemoryKnowledgeStore,
  MapSourceFetcherResolver,
  SourceScopedChunkAuthorizer,
  makeFetchedDocument,
} from './fakes.js';
import { KnowledgeIngestionService } from './knowledge-ingestion-service.js';
import { RagRetriever } from './rag-retriever.js';
import { NO_RELEVANT_KNOWLEDGE_MESSAGE, type ChunkAuthorizer } from './rag-types.js';

const ORG = 'org-1';

/** Build a principal in the test Organization, with optional overrides. */
function makePrincipal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    roles: ['standard_user'],
    teamIds: [],
    projectIds: [],
    allowedModels: [],
    premiumAuthorized: false,
    ...overrides,
  };
}

/** A complete attribution, for hand-built vector records. */
function attribution(sourceId: string, overrides: Partial<SourceAttribution> = {}): SourceAttribution {
  return {
    sourceId,
    sourceTitle: overrides.sourceTitle ?? `Title ${sourceId}`,
    location: overrides.location ?? `loc/${sourceId}`,
    link: overrides.link ?? `https://src/${sourceId}`,
  };
}

/**
 * Build a `knowledge_chunk` Vector_Store record with an explicit embedding so a
 * test can control its vector-similarity score precisely.
 */
function chunkRecord(input: {
  id: string;
  organizationId?: string;
  sourceId: string;
  documentId: string;
  ordinal?: number;
  text: string;
  embedding: number[];
  attribution?: SourceAttribution | Partial<SourceAttribution> | null;
}): VectorRecord {
  const attr =
    input.attribution === null
      ? undefined
      : input.attribution !== undefined && 'sourceId' in input.attribution
        ? (input.attribution as SourceAttribution)
        : attribution(input.sourceId, input.attribution ?? {});
  return {
    id: input.id,
    organizationId: input.organizationId ?? ORG,
    ownerType: 'knowledge_chunk',
    ownerId: input.documentId,
    embedding: input.embedding,
    metadata: {
      sourceId: input.sourceId,
      documentId: input.documentId,
      ordinal: input.ordinal ?? 0,
      text: input.text,
      ...(attr !== undefined ? { attribution: attr } : {}),
    },
  };
}

/** A constant 1536-dim embedding filled with `value`. */
function vec(value: number): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(value);
}

/** Build a retriever over a fresh vector store with the given authorizer + options. */
function makeRetriever(
  authorizer: ChunkAuthorizer = new AllowAllChunkAuthorizer(),
  options: Partial<ConstructorParameters<typeof RagRetriever>[0]> = {},
) {
  const vectors = new InMemoryVectorStore();
  const embedder = new DeterministicEmbedder();
  const retriever = new RagRetriever({
    embedder,
    vectorStore: vectors,
    authorizer,
    // A permissive threshold by default so scoring tests are not gated by it.
    defaultRelevanceThreshold: 0,
    ...options,
  });
  return { vectors, embedder, retriever };
}

describe('retrieve — hybrid retrieval and attribution (Req 24.1, 24.4)', () => {
  it('returns matching chunks ranked best-first with complete attribution', async () => {
    const { vectors, retriever } = makeRetriever();
    await vectors.upsert([
      chunkRecord({
        id: 'c-low',
        sourceId: 'src-a',
        documentId: 'doc-a',
        text: 'the capital of france is paris',
        embedding: vec(0.2),
      }),
      chunkRecord({
        id: 'c-high',
        sourceId: 'src-b',
        documentId: 'doc-b',
        text: 'paris is the capital city of france and the seine flows through it',
        embedding: vec(0.9),
      }),
    ]);

    const result = await retriever.retrieve('capital of france', makePrincipal());

    expect(result.found).toBe(true);
    expect(result.chunks).toHaveLength(2);
    // Non-increasing relevance score (Req 24.2).
    expect(result.chunks[0]!.score).toBeGreaterThanOrEqual(result.chunks[1]!.score);
    // Every returned chunk carries complete attribution (Req 24.4).
    for (const chunk of result.chunks) {
      expect(chunk.attribution.sourceId).not.toBe('');
      expect(chunk.attribution.sourceTitle).not.toBe('');
      expect(chunk.attribution.location).not.toBe('');
      expect(chunk.attribution.link).not.toBe('');
    }
  });

  it('combines keyword overlap with vector similarity (Req 24.1)', async () => {
    // Two chunks with the SAME embedding (equal vector score): the one whose
    // text overlaps the query keywords must rank higher via the hybrid score.
    const { vectors, retriever } = makeRetriever();
    await vectors.upsert([
      chunkRecord({
        id: 'c-keyword-match',
        sourceId: 'src-a',
        documentId: 'doc-a',
        text: 'kubernetes pod autoscaling configuration guide',
        embedding: vec(0.5),
      }),
      chunkRecord({
        id: 'c-no-keyword',
        sourceId: 'src-b',
        documentId: 'doc-b',
        text: 'unrelated cooking recipe for pasta',
        embedding: vec(0.5),
      }),
    ]);

    const result = await retriever.retrieve('kubernetes autoscaling', makePrincipal());

    expect(result.chunks[0]!.chunkId).toBe('c-keyword-match');
    expect(result.chunks[0]!.keywordScore).toBeGreaterThan(result.chunks[1]!.keywordScore);
  });
});

describe('retrieve — re-ranking and top-K (Req 24.2)', () => {
  it('never returns more than the configured top-K, keeping the highest-ranked', async () => {
    const { vectors, retriever } = makeRetriever();
    // Five chunks with strictly increasing embedding magnitude → increasing
    // vector similarity to a positive query vector.
    await vectors.upsert([
      chunkRecord({ id: 'c1', sourceId: 's', documentId: 'd1', text: 'alpha', embedding: vec(0.1) }),
      chunkRecord({ id: 'c2', sourceId: 's', documentId: 'd2', text: 'alpha', embedding: vec(0.3) }),
      chunkRecord({ id: 'c3', sourceId: 's', documentId: 'd3', text: 'alpha', embedding: vec(0.5) }),
      chunkRecord({ id: 'c4', sourceId: 's', documentId: 'd4', text: 'alpha', embedding: vec(0.7) }),
      chunkRecord({ id: 'c5', sourceId: 's', documentId: 'd5', text: 'alpha', embedding: vec(0.9) }),
    ]);

    const result = await retriever.retrieve('alpha', makePrincipal(), { topK: 2 });

    expect(result.chunks).toHaveLength(2);
    // Scores are non-increasing across the bounded result (Req 24.2).
    expect(result.chunks[0]!.score).toBeGreaterThanOrEqual(result.chunks[1]!.score);
  });

  it('orders the full result set by non-increasing score', async () => {
    const { vectors, retriever } = makeRetriever();
    await vectors.upsert([
      chunkRecord({ id: 'a', sourceId: 's', documentId: 'd1', text: 'term', embedding: vec(0.4) }),
      chunkRecord({ id: 'b', sourceId: 's', documentId: 'd2', text: 'term', embedding: vec(0.8) }),
      chunkRecord({ id: 'c', sourceId: 's', documentId: 'd3', text: 'term', embedding: vec(0.6) }),
    ]);

    const result = await retriever.retrieve('term', makePrincipal());

    const scores = result.chunks.map((chunk) => chunk.score);
    const sorted = [...scores].sort((x, y) => y - x);
    expect(scores).toEqual(sorted);
  });
});

describe('retrieve — permission filtering (Req 24.3)', () => {
  it('excludes chunks from a source the principal cannot access', async () => {
    const authorizer = new SourceScopedChunkAuthorizer(['src-allowed']);
    const { vectors, retriever } = makeRetriever(authorizer);
    await vectors.upsert([
      chunkRecord({
        id: 'allowed',
        sourceId: 'src-allowed',
        documentId: 'doc-1',
        text: 'visible knowledge',
        embedding: vec(0.7),
      }),
      chunkRecord({
        id: 'forbidden',
        sourceId: 'src-restricted',
        documentId: 'doc-2',
        text: 'visible knowledge',
        embedding: vec(0.9),
      }),
    ]);

    const result = await retriever.retrieve('visible knowledge', makePrincipal());

    expect(result.chunks.map((c) => c.chunkId)).toEqual(['allowed']);
  });

  it('returns no context when every candidate is unauthorized (Req 24.3, 24.7)', async () => {
    const authorizer = new SourceScopedChunkAuthorizer([]); // nothing allowed
    const { vectors, retriever } = makeRetriever(authorizer);
    await vectors.upsert([
      chunkRecord({
        id: 'forbidden',
        sourceId: 'src-restricted',
        documentId: 'doc-1',
        text: 'secret knowledge',
        embedding: vec(0.9),
      }),
    ]);

    const result = await retriever.retrieve('secret knowledge', makePrincipal());

    expect(result.found).toBe(false);
    expect(result.chunks).toHaveLength(0);
    expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
  });

  it('never returns another Organization\u2019s chunks (tenant isolation, Req 1.2)', async () => {
    const { vectors, retriever } = makeRetriever();
    await vectors.upsert([
      chunkRecord({
        id: 'mine',
        organizationId: ORG,
        sourceId: 'src-a',
        documentId: 'doc-a',
        text: 'shared term content',
        embedding: vec(0.8),
      }),
      chunkRecord({
        id: 'theirs',
        organizationId: 'org-other',
        sourceId: 'src-b',
        documentId: 'doc-b',
        text: 'shared term content',
        embedding: vec(0.8),
      }),
    ]);

    const result = await retriever.retrieve('shared term content', makePrincipal());

    expect(result.chunks.map((c) => c.chunkId)).toEqual(['mine']);
  });
});

describe('retrieve — attribution completeness gate (Req 24.4, 24.6)', () => {
  it('excludes a chunk that is missing an attribution field', async () => {
    const { vectors, retriever } = makeRetriever();
    await vectors.upsert([
      chunkRecord({
        id: 'complete',
        sourceId: 'src-a',
        documentId: 'doc-a',
        text: 'attributed content',
        embedding: vec(0.7),
      }),
      chunkRecord({
        id: 'incomplete',
        sourceId: 'src-b',
        documentId: 'doc-b',
        text: 'attributed content',
        embedding: vec(0.9),
        // Missing link → incomplete attribution (Req 24.6).
        attribution: { sourceTitle: 'No Link', location: 'loc', link: '' },
      }),
    ]);

    const result = await retriever.retrieve('attributed content', makePrincipal());

    expect(result.chunks.map((c) => c.chunkId)).toEqual(['complete']);
  });

  it('excludes a chunk with no attribution metadata at all', async () => {
    const { vectors, retriever } = makeRetriever();
    await vectors.upsert([
      chunkRecord({
        id: 'no-attr',
        sourceId: 'src-a',
        documentId: 'doc-a',
        text: 'orphan content',
        embedding: vec(0.9),
        attribution: null,
      }),
    ]);

    const result = await retriever.retrieve('orphan content', makePrincipal());

    expect(result.found).toBe(false);
    expect(result.chunks).toHaveLength(0);
  });
});

describe('retrieve — below-threshold signalling (Req 24.7)', () => {
  it('returns no context and an explicit signal when nothing meets the threshold', async () => {
    const { vectors, retriever } = makeRetriever(new AllowAllChunkAuthorizer(), {
      defaultRelevanceThreshold: 0.95,
    });
    await vectors.upsert([
      chunkRecord({
        id: 'weak',
        sourceId: 'src-a',
        documentId: 'doc-a',
        // Orthogonal-ish to the query; low keyword overlap and modest vector score.
        text: 'completely unrelated subject matter',
        embedding: vec(0.05),
      }),
    ]);

    const result = await retriever.retrieve('quantum entanglement', makePrincipal(), {
      minRelevanceScore: 0.95,
    });

    expect(result.found).toBe(false);
    expect(result.chunks).toHaveLength(0);
    expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
  });

  it('returns no context for an empty index', async () => {
    const { retriever } = makeRetriever();
    const result = await retriever.retrieve('anything', makePrincipal());
    expect(result.found).toBe(false);
    expect(result.message).toBe(NO_RELEVANT_KNOWLEDGE_MESSAGE);
  });
});

describe('retrieve — end-to-end with the Knowledge_Ingestion_Service (Property 28)', () => {
  it('retrieves chunks the ingestion service indexed, with their attribution', async () => {
    // Shared embedder + vector store across ingestion and retrieval so the
    // retriever reads exactly what ingestion wrote.
    const store = new InMemoryKnowledgeStore();
    const resolver = new MapSourceFetcherResolver();
    const fetcher = new FakeSourceFetcher();
    const embedder = new DeterministicEmbedder();
    const vectors = new InMemoryVectorStore();

    resolver.register('knowledge_hub', fetcher);
    const ingestion = new KnowledgeIngestionService({
      store,
      fetchers: resolver,
      embedder,
      vectorStore: vectors,
      idGenerator: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `src-${n}`;
        };
      })(),
      clock: () => '2024-01-01T00:00:00.000Z',
      chunkOptions: { chunkSize: 40, overlap: 5 },
    });

    const ctx = { organizationId: ORG, userId: 'user-1' };
    const source = await ingestion.connectSource(ctx, {
      collectionId: 'col-1',
      type: 'knowledge_hub',
    });
    fetcher.setDocuments(source.id, [
      makeFetchedDocument('handbook', {
        title: 'Engineering Handbook',
        content: 'deployment runbook describes how to roll out a release to production safely',
        location: 'page/handbook',
        link: 'https://hub/handbook',
      }),
    ]);
    await ingestion.ingest(ctx, source.id);

    const retriever = new RagRetriever({
      embedder,
      vectorStore: vectors,
      authorizer: new AllowAllChunkAuthorizer(),
      defaultRelevanceThreshold: 0,
    });

    const result = await retriever.retrieve('deployment runbook release', makePrincipal());

    expect(result.found).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(chunk.sourceId).toBe(source.id);
      expect(chunk.attribution).toEqual({
        sourceId: source.id,
        sourceTitle: 'Engineering Handbook',
        location: 'page/handbook',
        link: 'https://hub/handbook',
      });
    }
  });
});
