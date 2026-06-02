/**
 * Property-based tests for Knowledge_Ingestion_Service resilience.
 *
 * Two design properties are exercised, each tagged with its exact number from
 * the design document and checked over >= 100 generated iterations with
 * `fast-check`:
 *
 *  - Feature: auxify-ai-platform, Property 30 — per-document failure resilience
 *    (Req 23.8): a failure in one document is recorded and isolated; every
 *    other document in the same batch is still ingested, and the
 *    successfully-indexed siblings' chunks land intact in the Vector_Store.
 *  - Feature: auxify-ai-platform, Property 31 — graceful degradation of native
 *    ingestion when an optional connector is unavailable (Req 23.9): an
 *    unavailable optional connector yields a `connector_unavailable` report
 *    that indexes nothing and leaves the Vector_Store untouched, while a native
 *    source keeps ingesting uninterrupted.
 *
 * The tests are deliberately self-contained — they wire the real
 * {@link KnowledgeIngestionService} to the in-memory knowledge fakes
 * (`./fakes.js`), the spec-faithful {@link InMemoryVectorStore} from the storage
 * layer, and the {@link DeterministicEmbedder} from the File_Processor fakes —
 * so they exercise the genuine production orchestration with no real connector
 * SDK, embedding model, or database.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import type { Embedder } from '../file-processor/index.js';
import { EMBEDDING_DIMENSIONS, InMemoryVectorStore } from '../storage/index.js';

import {
  FakeSourceFetcher,
  InMemoryKnowledgeStore,
  MapSourceFetcherResolver,
  makeFetchedDocument,
} from './fakes.js';
import { KnowledgeIngestionService } from './knowledge-ingestion-service.js';
import {
  CONNECTOR_SOURCE_TYPES,
  NATIVE_SOURCE_TYPES,
  type FetchedDocument,
} from './types.js';

/** Minimum generated iterations per property (>= 100). */
const NUM_RUNS = 200;

/** The tenant scope every generated scenario runs under. */
const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

/**
 * A marker embedded in a document's content to make its embedding call throw.
 *
 * Uppercase so it can never collide with the lowercase-letters-only content the
 * generators produce for non-failing documents.
 */
const FAIL_MARKER = 'FAILMARKER';

/** A 1536-dim zero query vector that matches every stored chunk in a query. */
const ZERO_QUERY = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

/** The wired-up service plus the fakes a test asserts against. */
interface Harness {
  service: KnowledgeIngestionService;
  store: InMemoryKnowledgeStore;
  fetcher: FakeSourceFetcher;
  resolver: MapSourceFetcherResolver;
  vectors: InMemoryVectorStore;
}

/**
 * Build a service wired to fresh in-memory fakes, with deterministic ids/clock
 * and small chunks so multi-chunk documents are exercised. An `embedder`
 * override injects a custom {@link Embedder} (used to fail specific documents).
 */
function makeHarness(embedder: Embedder = new DeterministicEmbedder()): Harness {
  const store = new InMemoryKnowledgeStore();
  const fetcher = new FakeSourceFetcher();
  const resolver = new MapSourceFetcherResolver();
  const vectors = new InMemoryVectorStore();
  let n = 0;
  const service = new KnowledgeIngestionService({
    store,
    fetchers: resolver,
    embedder,
    vectorStore: vectors,
    idGenerator: () => {
      n += 1;
      return `src-${n}`;
    },
    clock: () => '2024-01-01T00:00:00.000Z',
    chunkOptions: { chunkSize: 20, overlap: 5 },
  });
  return { service, store, fetcher, resolver, vectors };
}

// ---------------------------------------------------------------------------
// Shared generators.
// ---------------------------------------------------------------------------

/** A single lowercase letter — the only characters non-failing content uses. */
const letterArb = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split(''));

/**
 * A non-empty, lowercase-letters-only document body. Letters-only guarantees a
 * non-blank normalized body (so it always yields >= 1 chunk) and that it can
 * never accidentally contain the uppercase {@link FAIL_MARKER}.
 */
const bodyArb: fc.Arbitrary<string> = fc
  .array(letterArb, { minLength: 1, maxLength: 60 })
  .map((chars) => chars.join(''));

// ---------------------------------------------------------------------------
// Property 30: Ingestion is resilient to individual document failures.
// ---------------------------------------------------------------------------

/** A generated document spec: whether it should fail, and its content body. */
interface DocSpec {
  shouldFail: boolean;
  body: string;
}

const docSpecArb: fc.Arbitrary<DocSpec> = fc.record({
  shouldFail: fc.boolean(),
  body: bodyArb,
});

/** An arbitrary batch of 1..8 documents with an arbitrary failing subset. */
const docBatchArb: fc.Arbitrary<DocSpec[]> = fc.array(docSpecArb, {
  minLength: 1,
  maxLength: 8,
});

/**
 * An {@link Embedder} that throws for any batch containing the
 * {@link FAIL_MARKER}, leaving every other document's embedding to succeed via
 * a {@link DeterministicEmbedder}. Since the service embeds one document's
 * chunks per call, this fails exactly the marked documents.
 */
function markerFailingEmbedder(): Embedder {
  const base = new DeterministicEmbedder();
  return {
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.some((t) => t.includes(FAIL_MARKER))) {
        throw new Error('embedding backend rejected the batch');
      }
      return base.embed(texts);
    },
  };
}

/** Materialize a doc spec at index `i` into a {@link FetchedDocument}. */
function materializeDoc(spec: DocSpec, i: number): FetchedDocument {
  // A failing document carries the marker (always present in its first chunk),
  // so the marker-failing embedder throws for it and only it.
  const content = spec.shouldFail ? `${FAIL_MARKER} ${spec.body}` : spec.body;
  return makeFetchedDocument(`doc-${i}`, { content });
}

describe('Feature: auxify-ai-platform, Property 30: Ingestion is resilient to individual document failures', () => {
  it('records every failing document and still ingests every remaining document, leaving siblings intact (Validates: Requirements 23.8)', async () => {
    await fc.assert(
      fc.asyncProperty(docBatchArb, async (specs) => {
        const h = makeHarness(markerFailingEmbedder());
        h.resolver.register('upload', h.fetcher);
        const source = await h.service.connectSource(ctx, {
          collectionId: 'col-1',
          type: 'upload',
        });
        h.fetcher.setDocuments(
          source.id,
          specs.map((spec, i) => materializeDoc(spec, i)),
        );

        const report = await h.service.ingest(ctx, source.id);

        // The run completes despite per-document failures (it never throws).
        expect(report.status).toBe('completed');
        expect(report.documents).toHaveLength(specs.length);

        const failingCount = specs.filter((s) => s.shouldFail).length;
        const indexedExpected = specs.length - failingCount;

        // Counts reconcile: every fetched document is either indexed or failed
        // (none unchanged on a first ingest).
        expect(report.failedCount).toBe(failingCount);
        expect(report.indexedCount).toBe(indexedExpected);
        expect(report.unchangedCount).toBe(0);
        expect(report.indexedCount + report.failedCount + report.unchangedCount).toBe(
          specs.length,
        );

        // Each document's outcome matches whether it was marked to fail.
        for (let i = 0; i < specs.length; i += 1) {
          const outcome = report.documents.find((d) => d.externalId === `doc-${i}`);
          expect(outcome).toBeDefined();
          if (outcome === undefined) {
            return;
          }
          expect(outcome.status).toBe(specs[i]!.shouldFail ? 'failed' : 'indexed');
        }

        // A run with any failed document is recorded `error`, else `synced`.
        const refreshed = await h.store.getSource(ctx, source.id);
        expect(refreshed?.syncStatus).toBe(failingCount > 0 ? 'error' : 'synced');

        // Sibling integrity: the Vector_Store holds exactly the chunks of the
        // successfully-indexed documents — a failure corrupts no siblings and
        // adds no vectors of its own.
        const expectedVectorIds = new Set<string>();
        for (const d of report.documents) {
          if (d.status === 'indexed') {
            // Every non-failing document produced at least one chunk.
            expect(d.vectorIds.length).toBeGreaterThan(0);
            for (const vid of d.vectorIds) {
              expectedVectorIds.add(vid);
            }
          }
        }

        const matches = await h.vectors.query(
          ZERO_QUERY,
          { organizationId: ctx.organizationId, ownerType: 'knowledge_chunk' },
          100_000,
        );
        const presentIds = new Set(matches.map((m) => m.id));
        expect(presentIds).toEqual(expectedVectorIds);
        expect(h.vectors.size()).toBe(expectedVectorIds.size);
      }),
      {
        numRuns: NUM_RUNS,
        // Always exercise the documented shapes: a mixed batch (failure isolated
        // between successes), an all-failing batch, and an all-succeeding batch.
        examples: [
          [
            [
              { shouldFail: false, body: 'alpha' },
              { shouldFail: true, body: 'boom' },
              { shouldFail: false, body: 'gamma' },
            ],
          ],
          [[{ shouldFail: true, body: 'boom' }]],
          [[{ shouldFail: false, body: 'alpha' }]],
        ],
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 31: Native operation degrades gracefully when optional sources are
// unavailable (the Knowledge_Ingestion_Service slice — Req 23.9).
// ---------------------------------------------------------------------------

/** A generated degradation scenario: a native source + an unavailable connector. */
interface DegradeScenario {
  nativeType: (typeof NATIVE_SOURCE_TYPES)[number];
  connectorType: (typeof CONNECTOR_SOURCE_TYPES)[number];
  nativeBodies: string[];
}

const degradeScenarioArb: fc.Arbitrary<DegradeScenario> = fc.record({
  nativeType: fc.constantFrom(...NATIVE_SOURCE_TYPES),
  connectorType: fc.constantFrom(...CONNECTOR_SOURCE_TYPES),
  nativeBodies: fc.array(bodyArb, { minLength: 1, maxLength: 6 }),
});

describe('Feature: auxify-ai-platform, Property 31: Native operation degrades gracefully when optional sources are unavailable', () => {
  it('reports connector_unavailable with nothing indexed and an untouched Vector_Store, while a native source keeps ingesting (Validates: Requirements 23.9)', async () => {
    await fc.assert(
      fc.asyncProperty(degradeScenarioArb, async ({ nativeType, connectorType, nativeBodies }) => {
        const h = makeHarness();
        // One fetcher serves both sources (it keys seeded docs / unavailability
        // by source id); register it for both the native and connector types.
        h.resolver.register(nativeType, h.fetcher);
        h.resolver.register(connectorType, h.fetcher);

        const native = await h.service.connectSource(ctx, {
          collectionId: 'col-1',
          type: nativeType,
        });
        const connector = await h.service.connectSource(ctx, {
          collectionId: 'col-1',
          type: connectorType,
        });

        const nativeDocs = nativeBodies.map((body, i) =>
          makeFetchedDocument(`n-${i}`, { content: body }),
        );
        h.fetcher.setDocuments(native.id, nativeDocs);
        h.fetcher.failConnector(connector.id, connectorType);

        // The unavailable optional connector degrades gracefully: a
        // connector_unavailable report, nothing indexed, Vector_Store untouched.
        const connectorReport = await h.service.ingest(ctx, connector.id);
        expect(connectorReport.status).toBe('connector_unavailable');
        expect(connectorReport.documents).toHaveLength(0);
        expect(connectorReport.indexedCount).toBe(0);
        expect(connectorReport.unchangedCount).toBe(0);
        expect(connectorReport.failedCount).toBe(0);
        expect(h.vectors.size()).toBe(0);

        const connectorSrc = await h.store.getSource(ctx, connector.id);
        expect(connectorSrc?.syncStatus).toBe('error');

        // The native source keeps operating uninterrupted by the dead connector.
        const nativeReport = await h.service.ingest(ctx, native.id);
        expect(nativeReport.status).toBe('completed');
        expect(nativeReport.indexedCount).toBe(nativeDocs.length);
        expect(nativeReport.failedCount).toBe(0);
        expect(nativeReport.unchangedCount).toBe(0);

        // Every native chunk is now retrievable; all stored vectors belong to
        // the native source (the connector contributed none).
        const matches = await h.vectors.query(
          ZERO_QUERY,
          { organizationId: ctx.organizationId, ownerType: 'knowledge_chunk' },
          100_000,
        );
        expect(matches.length).toBeGreaterThan(0);
        expect(h.vectors.size()).toBe(matches.length);

        const nativeSrc = await h.store.getSource(ctx, native.id);
        expect(nativeSrc?.syncStatus).toBe('synced');
      }),
      {
        numRuns: NUM_RUNS,
        examples: [
          [{ nativeType: 'upload', connectorType: 'notion', nativeBodies: ['alpha'] }],
          [
            {
              nativeType: 'github',
              connectorType: 'confluence',
              nativeBodies: ['alpha', 'beta'],
            },
          ],
        ],
      },
    );
  });
});
