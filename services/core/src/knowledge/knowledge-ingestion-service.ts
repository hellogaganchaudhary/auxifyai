/**
 * Knowledge_Ingestion_Service (Req 23.1-23.9).
 *
 * The service turns a connected knowledge source into retrievable, attributed
 * knowledge. {@link KnowledgeIngestionService} exposes:
 *
 *  - {@link KnowledgeIngestionService.connectSource} — register a native source
 *    (Req 23.1) or an optional connector (Req 23.2) on a collection;
 *  - {@link KnowledgeIngestionService.ingest} — fetch the source's documents and
 *    run parse → chunk → embed → index for each new or changed document
 *    (Req 23.3), skipping unchanged documents by content hash (Req 23.4),
 *    recording each per-document failure and continuing (Req 23.8), and
 *    degrading gracefully when an optional connector is unavailable (Req 23.9);
 *  - {@link KnowledgeIngestionService.detectChanges} — compute the content-hash
 *    change set without mutating anything (Req 23.4);
 *  - {@link KnowledgeIngestionService.onChangeNotification} — ingest on a
 *    real-time source's change notification (Req 23.5);
 *  - {@link KnowledgeIngestionService.reindex} — re-process every document of a
 *    source for a scheduled (Req 23.6) or manual (Req 23.7) re-index.
 *
 * Every external capability is an injected port — the tenant-scoped
 * {@link KnowledgeStore}, the {@link SourceFetcherResolver} that resolves a
 * {@link SourceFetcher} per source type, the {@link Embedder} and
 * {@link ContentHasher}, and the shared {@link VectorStore} — so the service is
 * pure orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`. It reuses the File_Processor's {@link chunkText} so the platform
 * has a single chunk/embed pipeline, and indexes every chunk as a
 * `knowledge_chunk` Vector_Store record scoped to the owning Organization
 * (Req 1.2, 44.2).
 */

import { randomUUID } from 'node:crypto';

import type { SourceAttribution, TenantContext } from '@auxify/types';

import { chunkText, EmbeddingCountError, type ChunkOptions, type Embedder } from '../file-processor/index.js';
import type { VectorRecord, VectorStore } from '../storage/index.js';

import { sha256ContentHasher } from './content-hash.js';
import {
  ConnectorUnavailableError,
  MissingSourceFetcherError,
  UnknownSourceError,
} from './errors.js';
import {
  isConnectorSourceType,
  type ContentHasher,
  type DocumentIngestOutcome,
  type FailedDocument,
  type FetchedDocument,
  type IndexedDocument,
  type KnowledgeChangeSet,
  type KnowledgeChunkRecord,
  type KnowledgeDocumentRecord,
  type KnowledgeIngestReport,
  type KnowledgeSource,
  type KnowledgeSourceConfig,
  type KnowledgeStore,
  type SourceFetcherResolver,
  type UnchangedDocument,
} from './types.js';

/** A unique-id source, injectable for deterministic tests. */
export interface KnowledgeIdGenerator {
  /** Return a new unique id. */
  (): string;
}

/** A clock returning the current ISO-8601 timestamp, injectable for tests. */
export interface KnowledgeClock {
  /** Return the current time as an ISO-8601 string. */
  (): string;
}

/**
 * Construction-time dependencies for the {@link KnowledgeIngestionService}.
 *
 * The {@link store}, {@link fetchers} resolver, {@link embedder}, and
 * {@link vectorStore} are required; the {@link hasher}, {@link idGenerator},
 * {@link clock}, and {@link chunkOptions} have defaults. Requiring the ports
 * keeps the service honest — it never silently skips fetching, hashing,
 * embedding, or indexing — while letting tests inject fakes.
 */
export interface KnowledgeIngestionServiceOptions {
  /** Tenant-scoped persistence for sources, documents, and chunks (Req 23.3). */
  store: KnowledgeStore;
  /** Resolves the {@link SourceFetcher} for a source type (Req 23.1, 23.2). */
  fetchers: SourceFetcherResolver;
  /** Embeds chunk texts into vectors (Req 23.3); reused from the File_Processor. */
  embedder: Embedder;
  /** Indexes chunk embeddings in the Vector_Store (Req 23.3). */
  vectorStore: VectorStore;
  /** Content hasher for change detection (defaults to SHA-256, Req 23.4). */
  hasher?: ContentHasher;
  /** Id generator for sources, documents, and chunks (defaults to `crypto.randomUUID`). */
  idGenerator?: KnowledgeIdGenerator;
  /** Clock for timestamps (defaults to `new Date().toISOString()`). */
  clock?: KnowledgeClock;
  /** Chunk size / overlap tuning (defaults from the File_Processor). */
  chunkOptions?: ChunkOptions;
}

/** A fetched document paired with its freshly computed content hash. */
interface HashedDocument {
  /** The fetched document. */
  doc: FetchedDocument;
  /** The hash of {@link doc}'s content (Req 23.4). */
  hash: string;
}

/**
 * The concrete Knowledge_Ingestion_Service. Construct it with the persistence,
 * fetcher resolver, embedder, and Vector_Store ports; the ingest/re-index
 * entry points return a {@link KnowledgeIngestReport} describing every document
 * (re-)indexed, skipped as unchanged, or recorded as failed.
 */
export class KnowledgeIngestionService {
  private readonly store: KnowledgeStore;
  private readonly fetchers: SourceFetcherResolver;
  private readonly embedder: Embedder;
  private readonly vectors: VectorStore;
  private readonly hasher: ContentHasher;
  private readonly newId: KnowledgeIdGenerator;
  private readonly now: KnowledgeClock;
  private readonly chunkOptions: ChunkOptions;

  constructor(options: KnowledgeIngestionServiceOptions) {
    this.store = options.store;
    this.fetchers = options.fetchers;
    this.embedder = options.embedder;
    this.vectors = options.vectorStore;
    this.hasher = options.hasher ?? sha256ContentHasher;
    this.newId = options.idGenerator ?? ((): string => randomUUID());
    this.now = options.clock ?? ((): string => new Date().toISOString());
    this.chunkOptions = options.chunkOptions ?? {};
  }

  /**
   * Connect a knowledge source to a collection (Req 23.1, 23.2).
   *
   * Supports the primary native sources (upload, Knowledge Hub pages, DMS
   * documents, messaging content, GitHub, email, web URL — Req 23.1) and the
   * optional interoperability connectors (Notion, Confluence, Drive, SharePoint
   * — Req 23.2). The source starts idle with no documents; the first
   * {@link ingest} populates it.
   *
   * @param ctx The tenant scope the source belongs to.
   * @param config The source's collection, type, and sync mode.
   * @returns The persisted, tenant-scoped source.
   */
  async connectSource(
    ctx: TenantContext,
    config: KnowledgeSourceConfig,
  ): Promise<KnowledgeSource> {
    const source: KnowledgeSource = {
      id: config.id ?? this.newId(),
      collectionId: config.collectionId,
      type: config.type,
      syncMode: config.syncMode ?? 'manual',
      syncStatus: 'idle',
      lastSyncAt: null,
      documentCount: 0,
      createdAt: this.now(),
    };
    return this.store.createSource(ctx, source);
  }

  /**
   * Ingest a source: parse → chunk → embed → index each new or changed
   * document, skipping unchanged ones (Req 23.3, 23.4).
   *
   * Fetches the source's current documents, hashes each one, and re-indexes
   * only those that are new or whose content hash changed since the last sync
   * (Req 23.4); a document whose hash is unchanged is skipped. Each document's
   * ingest is isolated: a failure is recorded and the remaining documents
   * continue (Req 23.8). If the source is an optional connector that is
   * unavailable, the run short-circuits to a `connector_unavailable` report so
   * native sources keep serving uninterrupted (Req 23.9).
   *
   * @param ctx The tenant scope the source belongs to.
   * @param sourceId The source to ingest.
   * @returns A report of every document's outcome with reconciled counts.
   * @throws {UnknownSourceError} When no source matches within the Organization.
   * @throws {MissingSourceFetcherError} When a native source has no fetcher.
   */
  async ingest(ctx: TenantContext, sourceId: string): Promise<KnowledgeIngestReport> {
    return this.run(ctx, sourceId, false);
  }

  /**
   * Re-process every document of a source, regardless of content hash, for a
   * scheduled (Req 23.6) or administrator-triggered manual (Req 23.7) re-index.
   *
   * Unlike {@link ingest}, this forces re-indexing of every fetched document so
   * an operator can rebuild the index even when content is unchanged (for
   * example after an embedding-model upgrade).
   *
   * @param ctx The tenant scope the source belongs to.
   * @param sourceId The source to re-index.
   * @returns A report of every document's outcome with reconciled counts.
   */
  async reindex(ctx: TenantContext, sourceId: string): Promise<KnowledgeIngestReport> {
    return this.run(ctx, sourceId, true);
  }

  /**
   * Ingest a source in response to its real-time change notification (Req 23.5).
   *
   * Convenience wrapper over {@link ingest} for a source configured with
   * `realtime` sync: on a change notification the service ingests the source's
   * updates immediately (re-indexing only what changed, Req 23.4).
   *
   * @param ctx The tenant scope the source belongs to.
   * @param sourceId The source whose change notification was received.
   */
  async onChangeNotification(ctx: TenantContext, sourceId: string): Promise<void> {
    await this.ingest(ctx, sourceId);
  }

  /**
   * Compute the content-hash change set for a source without mutating anything
   * (Req 23.4).
   *
   * Compares each fetched document's freshly computed hash to the stored
   * document's hash, partitioning into added / changed / unchanged / removed.
   * An unavailable optional connector yields an empty change set rather than an
   * error (Req 23.9).
   *
   * @param ctx The tenant scope the source belongs to.
   * @param sourceId The source to inspect.
   * @returns The change set describing pending re-index work.
   * @throws {UnknownSourceError} When no source matches within the Organization.
   */
  async detectChanges(ctx: TenantContext, sourceId: string): Promise<KnowledgeChangeSet> {
    const source = await this.requireSource(ctx, sourceId);

    const empty: KnowledgeChangeSet = {
      sourceId,
      added: [],
      changed: [],
      unchanged: [],
      removed: [],
    };

    let fetched: FetchedDocument[];
    try {
      fetched = await this.fetchDocuments(ctx, source);
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) {
        return empty;
      }
      throw error;
    }

    const stored = await this.store.listDocuments(ctx, sourceId);
    const storedByExternalId = new Map(stored.map((doc) => [doc.externalId, doc]));
    const seen = new Set<string>();

    const changeSet: KnowledgeChangeSet = { ...empty };
    for (const doc of fetched) {
      seen.add(doc.externalId);
      const existing = storedByExternalId.get(doc.externalId);
      if (existing === undefined) {
        changeSet.added.push(doc.externalId);
        continue;
      }
      if (existing.contentHash === this.hasher.hash(doc.content)) {
        changeSet.unchanged.push(doc.externalId);
      } else {
        changeSet.changed.push(doc.externalId);
      }
    }
    for (const doc of stored) {
      if (!seen.has(doc.externalId)) {
        changeSet.removed.push(doc.externalId);
      }
    }
    return changeSet;
  }

  /**
   * The shared ingest engine behind {@link ingest} and {@link reindex}.
   *
   * Resolves the source, fetches its documents (degrading gracefully for an
   * unavailable connector, Req 23.9), then ingests each document in isolation
   * (Req 23.8), skipping unchanged documents unless `force` is set (Req 23.4),
   * and finally reconciles and persists the source's sync bookkeeping.
   */
  private async run(
    ctx: TenantContext,
    sourceId: string,
    force: boolean,
  ): Promise<KnowledgeIngestReport> {
    const source = await this.requireSource(ctx, sourceId);
    await this.store.setSourceSyncState(ctx, sourceId, { syncStatus: 'syncing' });

    let fetched: FetchedDocument[];
    try {
      fetched = await this.fetchDocuments(ctx, source);
    } catch (error) {
      if (error instanceof ConnectorUnavailableError) {
        // An optional connector being down must not interrupt native sources
        // (Req 23.9, Property 31): record the degraded state and return.
        await this.store.setSourceSyncState(ctx, sourceId, { syncStatus: 'error' });
        return {
          sourceId,
          status: 'connector_unavailable',
          documents: [],
          indexedCount: 0,
          unchangedCount: 0,
          failedCount: 0,
        };
      }
      throw error;
    }

    const outcomes: DocumentIngestOutcome[] = [];
    for (const doc of fetched) {
      outcomes.push(await this.ingestDocument(ctx, source, doc, force));
    }

    const indexedCount = outcomes.filter((o) => o.status === 'indexed').length;
    const unchangedCount = outcomes.filter((o) => o.status === 'unchanged').length;
    const failedCount = outcomes.filter((o) => o.status === 'failed').length;

    // A run with any failed document is recorded as `error`, otherwise `synced`
    // (Req 23.8). documentCount reflects the documents now present at the source.
    await this.store.setSourceSyncState(ctx, sourceId, {
      syncStatus: failedCount > 0 ? 'error' : 'synced',
      lastSyncAt: this.now(),
      documentCount: indexedCount + unchangedCount,
    });

    return {
      sourceId,
      status: 'completed',
      documents: outcomes,
      indexedCount,
      unchangedCount,
      failedCount,
    };
  }

  /**
   * Ingest a single document end-to-end, isolating its failure (Req 23.8).
   *
   * Skips a document whose content hash matches the stored hash unless `force`
   * is set (Req 23.4); otherwise parses → chunks → embeds → indexes it and
   * persists the document + chunk records. Any thrown error is caught and
   * surfaced as a {@link FailedDocument} so the caller continues with the rest.
   */
  private async ingestDocument(
    ctx: TenantContext,
    source: KnowledgeSource,
    doc: FetchedDocument,
    force: boolean,
  ): Promise<DocumentIngestOutcome> {
    try {
      const hash = this.hasher.hash(doc.content);
      const existing = await this.store.getDocumentByExternalId(ctx, source.id, doc.externalId);

      if (!force && existing !== null && existing.contentHash === hash) {
        const unchanged: UnchangedDocument = {
          status: 'unchanged',
          externalId: doc.externalId,
          documentId: existing.id,
          contentHash: hash,
        };
        return unchanged;
      }

      return await this.indexDocument(ctx, source, { doc, hash }, existing);
    } catch (error) {
      // Per-document resilience: record the failure and let the run continue
      // (Req 23.8). The error message is safe (no secrets) by construction.
      const failed: FailedDocument = {
        status: 'failed',
        externalId: doc.externalId,
        title: doc.title,
        error: error instanceof Error ? error.message : String(error),
      };
      return failed;
    }
  }

  /**
   * Parse → chunk → embed → index a new or changed document and persist its
   * document + chunk records (Req 23.3, 23.4).
   *
   * Chunks the content with the shared {@link chunkText}, embeds every chunk
   * (enforcing exactly one embedding per chunk via {@link EmbeddingCountError},
   * Property 28), upserts the chunk embeddings as `knowledge_chunk` Vector_Store
   * records scoped to the Organization, attaches a complete
   * {@link SourceAttribution} to each chunk (Req 24.4), and replaces the
   * document's prior chunks wholesale so a re-index never leaves stale vectors.
   */
  private async indexDocument(
    ctx: TenantContext,
    source: KnowledgeSource,
    hashed: HashedDocument,
    existing: KnowledgeDocumentRecord | null,
  ): Promise<IndexedDocument> {
    const { doc, hash } = hashed;
    const chunks = chunkText(doc.content, this.chunkOptions);

    const document = await this.store.saveDocument(ctx, {
      ...(existing !== null ? { id: existing.id } : {}),
      sourceId: source.id,
      externalId: doc.externalId,
      title: doc.title,
      contentHash: hash,
    });

    const attribution: SourceAttribution = {
      sourceId: source.id,
      sourceTitle: doc.title,
      location: doc.location ?? doc.externalId,
      link: doc.link ?? doc.externalId,
    };

    const chunkRecords: KnowledgeChunkRecord[] = [];
    const vectorRecords: VectorRecord[] = [];
    const vectorIds: string[] = [];

    if (chunks.length > 0) {
      const embeddings = await this.embedder.embed(chunks);
      if (embeddings.length !== chunks.length) {
        // Fail closed rather than index a partial/mismatched set (Property 28).
        throw new EmbeddingCountError(chunks.length, embeddings.length);
      }
      for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
        const chunkId = `${document.id}:${ordinal}`;
        vectorIds.push(chunkId);
        chunkRecords.push({
          id: chunkId,
          documentId: document.id,
          ordinal,
          text: chunks[ordinal]!,
          vectorId: chunkId,
          attribution,
        });
        vectorRecords.push({
          id: chunkId,
          organizationId: ctx.organizationId,
          ownerType: 'knowledge_chunk',
          ownerId: document.id,
          embedding: embeddings[ordinal]!,
          metadata: {
            sourceId: source.id,
            documentId: document.id,
            ordinal,
            text: chunks[ordinal]!,
            attribution,
          },
        });
      }
    }

    // Replace the document's chunks wholesale: delete the prior vectors (from a
    // previous index of this document) before writing the new ones, so a
    // re-index never leaves orphaned vectors (Req 23.4).
    const prior = await this.store.listChunks(ctx, document.id);
    const priorVectorIds = prior.map((chunk) => chunk.vectorId);
    if (priorVectorIds.length > 0) {
      await this.vectors.delete(priorVectorIds);
    }
    await this.store.replaceChunks(ctx, document.id, chunkRecords);
    if (vectorRecords.length > 0) {
      await this.vectors.upsert(vectorRecords);
    }

    return {
      status: 'indexed',
      externalId: doc.externalId,
      documentId: document.id,
      title: doc.title,
      chunkCount: chunks.length,
      vectorIds,
      contentHash: hash,
    };
  }

  /** Resolve a source within the tenant scope or raise {@link UnknownSourceError}. */
  private async requireSource(ctx: TenantContext, sourceId: string): Promise<KnowledgeSource> {
    const source = await this.store.getSource(ctx, sourceId);
    if (source === null) {
      throw new UnknownSourceError(sourceId);
    }
    return source;
  }

  /**
   * Resolve the source's fetcher and fetch its documents (Req 23.1, 23.2).
   *
   * A *native* source with no registered fetcher is a hard configuration error
   * ({@link MissingSourceFetcherError}); an *optional* connector with no fetcher
   * degrades gracefully and is reported as unavailable
   * ({@link ConnectorUnavailableError}, Req 23.9).
   */
  private async fetchDocuments(
    ctx: TenantContext,
    source: KnowledgeSource,
  ): Promise<FetchedDocument[]> {
    const fetcher = this.fetchers.resolve(source.type);
    if (fetcher === undefined) {
      if (isConnectorSourceType(source.type)) {
        throw new ConnectorUnavailableError(source.type, 'no connector is configured');
      }
      throw new MissingSourceFetcherError(source.type);
    }
    return fetcher.fetch(ctx, source);
  }
}
