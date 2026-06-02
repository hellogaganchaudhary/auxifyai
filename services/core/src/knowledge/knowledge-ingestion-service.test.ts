/**
 * Unit tests for the Knowledge_Ingestion_Service (Req 23.1-23.9).
 *
 * These exercise the full ingest surface against the in-memory fakes and the
 * spec-faithful {@link InMemoryVectorStore} — no real connector SDK, embedding
 * model, or database:
 *
 *  - source connection for native and optional connector types (Req 23.1, 23.2);
 *  - parse → chunk → embed → index with one embedding per chunk and complete
 *    attribution (Req 23.3, 24.4);
 *  - content-hash change detection re-indexing only changed documents (Req 23.4);
 *  - real-time change notification (Req 23.5) and forced manual re-index
 *    (Req 23.6, 23.7);
 *  - per-document failure resilience (Req 23.8);
 *  - graceful degradation when an optional connector is unavailable (Req 23.9).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import { EMBEDDING_DIMENSIONS, InMemoryVectorStore } from '../storage/index.js';

import { sha256ContentHasher } from './content-hash.js';
import { ConnectorUnavailableError, MissingSourceFetcherError, UnknownSourceError } from './errors.js';
import {
  FakeSourceFetcher,
  InMemoryKnowledgeStore,
  MapSourceFetcherResolver,
  makeFetchedDocument,
} from './fakes.js';
import {
  KnowledgeIngestionService,
  type KnowledgeIngestionServiceOptions,
} from './knowledge-ingestion-service.js';
import type { KnowledgeSourceType } from './types.js';

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };

interface Harness {
  service: KnowledgeIngestionService;
  store: InMemoryKnowledgeStore;
  fetcher: FakeSourceFetcher;
  resolver: MapSourceFetcherResolver;
  embedder: DeterministicEmbedder;
  vectors: InMemoryVectorStore;
}

/** Build a service wired to fresh fakes, with deterministic ids/clock and small chunks. */
function makeService(overrides: Partial<KnowledgeIngestionServiceOptions> = {}): Harness {
  const store = new InMemoryKnowledgeStore();
  const fetcher = new FakeSourceFetcher();
  const resolver = new MapSourceFetcherResolver();
  const embedder = new DeterministicEmbedder();
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
    ...overrides,
  });
  return { service, store, fetcher, resolver, embedder, vectors };
}

/** Connect a source of `type` after registering `fetcher` as its handler. */
async function connect(
  h: Harness,
  type: KnowledgeSourceType = 'upload',
  fetcher = h.fetcher,
) {
  h.resolver.register(type, fetcher);
  return h.service.connectSource(ctx, { collectionId: 'col-1', type });
}

describe('connectSource (Req 23.1, 23.2)', () => {
  it('connects a native source idle with no documents', async () => {
    const h = makeService();
    const source = await connect(h, 'github');
    expect(source.id).toBe('src-1');
    expect(source.type).toBe('github');
    expect(source.syncMode).toBe('manual');
    expect(source.syncStatus).toBe('idle');
    expect(source.lastSyncAt).toBeNull();
    expect(source.documentCount).toBe(0);
  });

  it('connects an optional connector source with the requested sync mode', async () => {
    const h = makeService();
    h.resolver.register('notion', h.fetcher);
    const source = await h.service.connectSource(ctx, {
      collectionId: 'col-1',
      type: 'notion',
      syncMode: 'scheduled',
    });
    expect(source.type).toBe('notion');
    expect(source.syncMode).toBe('scheduled');
  });
});

describe('ingest — parse, chunk, embed, index (Req 23.3, 24.4)', () => {
  it('indexes each fetched document as knowledge_chunk vectors with attribution', async () => {
    const h = makeService();
    const source = await connect(h, 'knowledge_hub');
    h.fetcher.setDocuments(source.id, [
      makeFetchedDocument('doc-a', {
        title: 'Onboarding',
        content: 'A'.repeat(60),
        location: 'page/onboarding',
        link: 'https://hub/onboarding',
      }),
    ]);

    const report = await h.service.ingest(ctx, source.id);

    expect(report.status).toBe('completed');
    expect(report.indexedCount).toBe(1);
    const indexed = report.documents[0]!;
    expect(indexed.status).toBe('indexed');
    if (indexed.status === 'indexed') {
      expect(indexed.chunkCount).toBeGreaterThan(1);
      expect(indexed.vectorIds).toHaveLength(indexed.chunkCount);
      // Exactly one embedding per chunk (Property 28).
      expect(h.embedder.calls).toHaveLength(1);
      expect(h.embedder.calls[0]).toHaveLength(indexed.chunkCount);
      expect(h.vectors.size()).toBe(indexed.chunkCount);

      const matches = await h.vectors.query(
        new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
        { organizationId: 'org-1', ownerType: 'knowledge_chunk' },
        100,
      );
      expect(matches).toHaveLength(indexed.chunkCount);
      // Complete source attribution travels with every chunk (Req 24.4).
      for (const m of matches) {
        expect(m.metadata['attribution']).toEqual({
          sourceId: source.id,
          sourceTitle: 'Onboarding',
          location: 'page/onboarding',
          link: 'https://hub/onboarding',
        });
      }
    }

    // The source's bookkeeping is reconciled.
    const refreshed = await h.store.getSource(ctx, source.id);
    expect(refreshed?.syncStatus).toBe('synced');
    expect(refreshed?.lastSyncAt).toBe('2024-01-01T00:00:00.000Z');
    expect(refreshed?.documentCount).toBe(1);
  });

  it('indexes records scoped to the owning Organization (Req 1.2)', async () => {
    const otherCtx: TenantContext = { organizationId: 'org-9', userId: 'user-9' };
    const h = makeService();
    h.resolver.register('upload', h.fetcher);
    const source = await h.service.connectSource(otherCtx, { collectionId: 'c', type: 'upload' });
    h.fetcher.setDocuments(source.id, [makeFetchedDocument('d1', { content: 'hello world' })]);
    await h.service.ingest(otherCtx, source.id);

    const sameOrg = await h.vectors.query(
      new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
      { organizationId: 'org-9' },
      100,
    );
    const otherOrg = await h.vectors.query(
      new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
      { organizationId: 'org-1' },
      100,
    );
    expect(sameOrg.length).toBeGreaterThan(0);
    expect(otherOrg).toHaveLength(0);
  });

  it('produces no chunks or vectors for empty document content', async () => {
    const h = makeService();
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [makeFetchedDocument('empty', { content: '   ' })]);
    const report = await h.service.ingest(ctx, source.id);
    const indexed = report.documents[0]!;
    expect(indexed.status).toBe('indexed');
    if (indexed.status === 'indexed') {
      expect(indexed.chunkCount).toBe(0);
    }
    expect(h.vectors.size()).toBe(0);
  });

  it('raises UnknownSourceError for a source outside the tenant scope', async () => {
    const h = makeService();
    await expect(h.service.ingest(ctx, 'missing')).rejects.toBeInstanceOf(UnknownSourceError);
  });

  it('raises MissingSourceFetcherError for a native source with no fetcher', async () => {
    const h = makeService();
    // Connect without registering a fetcher for the native type.
    const source = await h.service.connectSource(ctx, { collectionId: 'c', type: 'email' });
    await expect(h.service.ingest(ctx, source.id)).rejects.toBeInstanceOf(
      MissingSourceFetcherError,
    );
  });
});

describe('ingest — content-hash change detection (Req 23.4)', () => {
  it('re-indexes only changed documents on a second ingest', async () => {
    const h = makeService();
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [
      makeFetchedDocument('a', { content: 'alpha content here' }),
      makeFetchedDocument('b', { content: 'beta content here' }),
    ]);
    const first = await h.service.ingest(ctx, source.id);
    expect(first.indexedCount).toBe(2);

    // Change only document b; a is byte-identical.
    h.fetcher.setDocuments(source.id, [
      makeFetchedDocument('a', { content: 'alpha content here' }),
      makeFetchedDocument('b', { content: 'beta content CHANGED' }),
    ]);
    const second = await h.service.ingest(ctx, source.id);

    expect(second.unchangedCount).toBe(1);
    expect(second.indexedCount).toBe(1);
    const reindexed = second.documents.find((d) => d.status === 'indexed');
    expect(reindexed?.status).toBe('indexed');
    if (reindexed?.status === 'indexed') {
      expect(reindexed.externalId).toBe('b');
    }
    const skipped = second.documents.find((d) => d.status === 'unchanged');
    expect(skipped?.status).toBe('unchanged');
    if (skipped?.status === 'unchanged') {
      expect(skipped.externalId).toBe('a');
    }
  });

  it('replaces prior vectors on re-index without leaving orphans', async () => {
    const h = makeService();
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [makeFetchedDocument('a', { content: 'A'.repeat(80) })]);
    await h.service.ingest(ctx, source.id);
    const afterFirst = h.vectors.size();
    expect(afterFirst).toBeGreaterThan(1);

    // Shorter content → fewer chunks; the prior, longer set must be removed.
    h.fetcher.setDocuments(source.id, [makeFetchedDocument('a', { content: 'short' })]);
    await h.service.ingest(ctx, source.id);

    const matches = await h.vectors.query(
      new Array<number>(EMBEDDING_DIMENSIONS).fill(0),
      { organizationId: 'org-1', ownerType: 'knowledge_chunk' },
      100,
    );
    expect(matches).toHaveLength(1);
  });

  it('detectChanges reports added/changed/unchanged/removed without mutating', async () => {
    const h = makeService();
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [
      makeFetchedDocument('keep', { content: 'unchanged content' }),
      makeFetchedDocument('gone', { content: 'will be removed' }),
    ]);
    await h.service.ingest(ctx, source.id);

    h.fetcher.setDocuments(source.id, [
      makeFetchedDocument('keep', { content: 'unchanged content' }),
      makeFetchedDocument('edit', { content: 'a brand new document' }),
    ]);
    const embedCallsBeforeDetect = h.embedder.calls.length;
    const changes = await h.service.detectChanges(ctx, source.id);

    expect(changes.added).toEqual(['edit']);
    expect(changes.unchanged).toEqual(['keep']);
    expect(changes.removed).toEqual(['gone']);
    expect(changes.changed).toEqual([]);
    // detectChanges only hashes; it must not embed or index anything.
    expect(h.embedder.calls).toHaveLength(embedCallsBeforeDetect);
  });
});

describe('reindex and onChangeNotification (Req 23.5, 23.6, 23.7)', () => {
  it('reindex re-processes even unchanged documents (Req 23.6, 23.7)', async () => {
    const h = makeService();
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [makeFetchedDocument('a', { content: 'stable content' })]);
    await h.service.ingest(ctx, source.id);

    const report = await h.service.reindex(ctx, source.id);
    expect(report.indexedCount).toBe(1);
    expect(report.unchangedCount).toBe(0);
  });

  it('onChangeNotification ingests the source (Req 23.5)', async () => {
    const h = makeService();
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [makeFetchedDocument('a', { content: 'realtime update' })]);
    await h.service.onChangeNotification(ctx, source.id);
    expect(h.fetcher.calls).toContain(source.id);
    expect(h.vectors.size()).toBeGreaterThan(0);
  });
});

describe('ingest — per-document failure resilience (Req 23.8)', () => {
  it('records a failed document and continues ingesting the rest', async () => {
    // An embedder that throws for one marker document's batch, leaving the
    // others to succeed — the failure must be isolated to that document.
    const base = new DeterministicEmbedder();
    const failing = {
      embed: async (texts: string[]): Promise<number[][]> => {
        if (texts.some((t) => t.includes('explodes'))) {
          throw new Error('embedding backend rejected the batch');
        }
        return base.embed(texts);
      },
    };
    const h = makeService({ embedder: failing });
    const source = await connect(h);
    h.fetcher.setDocuments(source.id, [
      makeFetchedDocument('good-1', { content: 'good content one' }),
      makeFetchedDocument('BOOM', { content: 'this one explodes' }),
      makeFetchedDocument('good-2', { content: 'good content two' }),
    ]);

    const report = await h.service.ingest(ctx, source.id);
    expect(report.status).toBe('completed');
    expect(report.indexedCount).toBe(2);
    expect(report.failedCount).toBe(1);
    const failed = report.documents.find((d) => d.status === 'failed');
    expect(failed?.status).toBe('failed');
    if (failed?.status === 'failed') {
      expect(failed.externalId).toBe('BOOM');
      expect(failed.error).toContain('rejected');
    }
    // The source is marked error because at least one document failed.
    const refreshed = await h.store.getSource(ctx, source.id);
    expect(refreshed?.syncStatus).toBe('error');
  });
});

describe('ingest — graceful connector degradation (Req 23.9)', () => {
  it('returns a connector_unavailable report rather than throwing', async () => {
    const h = makeService();
    h.resolver.register('notion', h.fetcher);
    const source = await h.service.connectSource(ctx, { collectionId: 'c', type: 'notion' });
    h.fetcher.failConnector(source.id, 'notion');

    const report = await h.service.ingest(ctx, source.id);
    expect(report.status).toBe('connector_unavailable');
    expect(report.documents).toHaveLength(0);
    expect(report.indexedCount).toBe(0);
    // Nothing indexed; native sources are unaffected.
    expect(h.vectors.size()).toBe(0);
  });

  it('treats an unconfigured optional connector as unavailable, not a hard error', async () => {
    const h = makeService();
    // Connect a connector source without registering any fetcher for it.
    const source = await h.service.connectSource(ctx, { collectionId: 'c', type: 'confluence' });
    const report = await h.service.ingest(ctx, source.id);
    expect(report.status).toBe('connector_unavailable');
  });

  it('detectChanges yields an empty change set for an unavailable connector', async () => {
    const h = makeService();
    h.resolver.register('sharepoint', h.fetcher);
    const source = await h.service.connectSource(ctx, { collectionId: 'c', type: 'sharepoint' });
    h.fetcher.failConnector(source.id, 'sharepoint');
    const changes = await h.service.detectChanges(ctx, source.id);
    expect(changes.added).toEqual([]);
    expect(changes.changed).toEqual([]);
    expect(changes.unchanged).toEqual([]);
    expect(changes.removed).toEqual([]);
  });
});

describe('ConnectorUnavailableError projection (Req 23.9, 46.8)', () => {
  it('projects to a retriable provider_unavailable platform error', () => {
    const err = new ConnectorUnavailableError('notion').toPlatformError('corr-1');
    expect(err.category).toBe('provider_unavailable');
    expect(err.retriable).toBe(true);
    expect(err.correlationId).toBe('corr-1');
    expect(err.details).toEqual({ connector: 'notion' });
  });
});

describe('content hashing (Req 23.4)', () => {
  it('is deterministic and content-sensitive', () => {
    expect(sha256ContentHasher.hash('same')).toBe(sha256ContentHasher.hash('same'));
    expect(sha256ContentHasher.hash('a')).not.toBe(sha256ContentHasher.hash('b'));
  });
});
