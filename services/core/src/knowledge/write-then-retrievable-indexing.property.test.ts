/**
 * Property-based test for write-then-retrievable knowledge indexing.
 *
 * Feature: auxify-ai-platform, Property 28: Native content written becomes
 * retrievable with one embedding per chunk.
 *
 * Design statement (Property 28): "For any successfully processed file,
 * ingested source document, knowledge page, document, or messaging item, every
 * produced chunk has exactly one generated embedding, the chunks are indexed in
 * the Vector_Store, and the content is subsequently retrievable through RAG and
 * Unified Search."
 *
 * Validates: Requirements 11.4, 11.5, 23.3, 26.8, 27.9, 28.5
 *
 * This test drives the Knowledge_Ingestion_Service (task 12.1) over arbitrary
 * populations of source documents and, for each successfully ingested document,
 * asserts the full write-then-retrievable contract directly against the shared
 * {@link InMemoryVectorStore} (the RAG_Retriever is intentionally not used here,
 * keeping the test self-contained against the ingestion + storage layers):
 *
 *   1. exactly one Vector_Store record exists per produced chunk — the number
 *      of records for a document equals its chunk count, and the embedder was
 *      asked for exactly one embedding per chunk (Req 11.4, 23.3);
 *   2. every produced chunk is retrievable via an Organization-scoped
 *      Vector_Store query as a `knowledge_chunk` record (Req 11.5, 28.5);
 *   3. each retrieved record carries the document's complete
 *      {@link SourceAttribution} (Req 23.3 / 24.4);
 *   4. a query under a *different* Organization never returns these chunks —
 *      indexed content stays tenant-scoped (Req 1.2).
 *
 * The pure {@link chunkText} contract reused by the service is used as the
 * oracle for the expected chunk count, so the property holds across empty,
 * single-chunk, and multi-chunk content without hard-coding sizes.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SourceAttribution, TenantContext } from '@auxify/types';

import { chunkText, type ChunkOptions } from '../file-processor/index.js';
import { DeterministicEmbedder } from '../file-processor/fakes.js';
import { EMBEDDING_DIMENSIONS, InMemoryVectorStore } from '../storage/index.js';

import {
  FakeSourceFetcher,
  InMemoryKnowledgeStore,
  MapSourceFetcherResolver,
} from './fakes.js';
import { KnowledgeIngestionService } from './knowledge-ingestion-service.js';
import type { FetchedDocument, IndexedDocument } from './types.js';

/** Minimum generated iterations required for this property (>= 100). */
const NUM_RUNS = 200;

/** Small chunks so generated content readily produces single- and multi-chunk documents. */
const CHUNK_OPTIONS: ChunkOptions = { chunkSize: 20, overlap: 5 };

/** A query vector; the in-memory store returns every org-scoped record regardless of score. */
const PROBE = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

/** A `k` larger than any population so a query returns every matching record. */
const ALL = 100_000;

/**
 * Content generator biased to exercise the three regimes that matter for the
 * property: blank content (zero chunks), short content (a single chunk), and
 * long content (many overlapping chunks). Actual chunk counts are computed from
 * {@link chunkText}, so the property never assumes a fixed split.
 */
const contentArb: fc.Arbitrary<string> = fc.oneof(
  // Blank / whitespace-only → normalizes to zero chunks (nothing to embed).
  { weight: 1, arbitrary: fc.constantFrom('', '   ', '\n\t  \n') },
  // Likely a single chunk.
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 19 }) },
  // Likely several overlapping chunks.
  { weight: 3, arbitrary: fc.string({ minLength: 21, maxLength: 200 }) },
);

/** A document spec; the externalId is assigned by index so a population is always unique-keyed. */
interface DocSpec {
  title: string;
  content: string;
  location: string | undefined;
  link: string | undefined;
}

const docSpecArb: fc.Arbitrary<DocSpec> = fc.record({
  title: fc.string({ minLength: 1, maxLength: 40 }),
  content: contentArb,
  location: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  link: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
});

/** A scenario: two distinct Organizations and a population of documents to ingest. */
const scenarioArb = fc.record({
  // Distinct prefixes guarantee the owning and foreign Organizations never collide.
  owningOrg: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `own-${s}`),
  foreignOrg: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `for-${s}`),
  userId: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `usr-${s}`),
  docs: fc.array(docSpecArb, { minLength: 1, maxLength: 6 }),
});

/** Build a {@link FetchedDocument} for the document at `index`, with a unique external id. */
function toFetchedDocument(spec: DocSpec, index: number): FetchedDocument {
  return {
    externalId: `doc-${index}`,
    title: spec.title,
    content: spec.content,
    ...(spec.location !== undefined ? { location: spec.location } : {}),
    ...(spec.link !== undefined ? { link: spec.link } : {}),
  };
}

/** The complete attribution the service is expected to attach to every chunk of `doc`. */
function expectedAttribution(sourceId: string, doc: FetchedDocument): SourceAttribution {
  return {
    sourceId,
    sourceTitle: doc.title,
    location: doc.location ?? doc.externalId,
    link: doc.link ?? doc.externalId,
  };
}

describe('Feature: auxify-ai-platform, Property 28: Native content written becomes retrievable with one embedding per chunk', () => {
  it('indexes exactly one embedding per chunk and makes every chunk retrievable, scoped to the owning Organization', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const ctx: TenantContext = {
          organizationId: scenario.owningOrg,
          userId: scenario.userId,
        };
        const foreignCtx: TenantContext = {
          organizationId: scenario.foreignOrg,
          userId: scenario.userId,
        };

        const store = new InMemoryKnowledgeStore();
        const fetcher = new FakeSourceFetcher();
        const resolver = new MapSourceFetcherResolver().register('upload', fetcher);
        const embedder = new DeterministicEmbedder();
        const vectors = new InMemoryVectorStore();
        const service = new KnowledgeIngestionService({
          store,
          fetchers: resolver,
          embedder,
          vectorStore: vectors,
          chunkOptions: CHUNK_OPTIONS,
        });

        const source = await service.connectSource(ctx, { collectionId: 'col-1', type: 'upload' });
        const docs = scenario.docs.map(toFetchedDocument);
        fetcher.setDocuments(source.id, docs);

        const report = await service.ingest(ctx, source.id);

        // Every fetched document is processed successfully (the embedder never fails).
        expect(report.status).toBe('completed');
        expect(report.failedCount).toBe(0);
        expect(report.documents).toHaveLength(docs.length);
        expect(report.documents.every((d) => d.status === 'indexed')).toBe(true);

        const indexed = report.documents.filter(
          (d): d is IndexedDocument => d.status === 'indexed',
        );
        const docByExternalId = new Map(docs.map((d) => [d.externalId, d]));

        let totalChunks = 0;

        for (const result of indexed) {
          const doc = docByExternalId.get(result.externalId)!;
          const expectedChunks = chunkText(doc.content, CHUNK_OPTIONS);
          const attribution = expectedAttribution(source.id, doc);
          totalChunks += expectedChunks.length;

          // (1) The service reports exactly one Vector_Store id per produced chunk.
          expect(result.chunkCount).toBe(expectedChunks.length);
          expect(result.vectorIds).toHaveLength(expectedChunks.length);
          expect(new Set(result.vectorIds).size).toBe(expectedChunks.length);

          // (2) Every produced chunk is retrievable, scoped to the owning
          //     Organization, as a knowledge_chunk record for this document.
          const matches = await vectors.query(
            PROBE,
            {
              organizationId: scenario.owningOrg,
              ownerType: 'knowledge_chunk',
              ownerId: result.documentId,
            },
            ALL,
          );

          // The record count for a document equals its chunk count — no missing,
          // duplicated, or orphaned vectors.
          expect(matches).toHaveLength(expectedChunks.length);
          expect(new Set(matches.map((m) => m.id))).toEqual(new Set(result.vectorIds));

          for (const match of matches) {
            // (3) Each retrieved record carries the document's complete attribution.
            expect(match.ownerType).toBe('knowledge_chunk');
            expect(match.ownerId).toBe(result.documentId);
            expect(match.metadata['attribution']).toEqual(attribution);
            expect(match.metadata['sourceId']).toBe(source.id);
            expect(match.metadata['documentId']).toBe(result.documentId);
            expect(typeof match.metadata['text']).toBe('string');
          }
        }

        // The embedder was asked for exactly one embedding per chunk overall: a
        // batch per document with at least one chunk, each batch sized to that
        // document's chunk count. Summed, this is one embedding per chunk.
        const totalEmbeddings = embedder.calls.reduce(
          (sum: number, batch: string[]) => sum + batch.length,
          0,
        );
        expect(totalEmbeddings).toBe(totalChunks);

        // No stray vectors beyond the chunks just indexed.
        expect(vectors.size()).toBe(totalChunks);

        // (4) Tenant isolation: a query under a different Organization never
        //     returns any of these chunks.
        const foreign = await vectors.query(
          PROBE,
          { organizationId: scenario.foreignOrg, ownerType: 'knowledge_chunk' },
          ALL,
        );
        expect(foreign).toHaveLength(0);

        // The owning Organization sees exactly the indexed chunks across the source.
        const owned = await vectors.query(
          PROBE,
          { organizationId: scenario.owningOrg, ownerType: 'knowledge_chunk' },
          ALL,
        );
        expect(owned).toHaveLength(totalChunks);
        expect(foreignCtx.organizationId).not.toBe(ctx.organizationId);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
