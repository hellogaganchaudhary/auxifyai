/**
 * The native-module ingestion bridge (Req 26.8, 27.9, 28.5).
 *
 * The {@link NativeIngestionBridge} provides the concrete adapters for the three
 * native modules' ingestion-on-write seams — the Knowledge_Hub_Service's
 * {@link PageIngestionEmitter}, the Messaging_Service's
 * {@link MessageIngestionEmitter}, and the Document_Management_Service's
 * {@link DocumentIngestionEmitter} — so that creating a page, posting a message,
 * or uploading a document forwards the content to the
 * {@link KnowledgeIngestionService}, which parses → chunks → embeds → indexes it
 * as a retrievable `knowledge_chunk` record with complete
 * {@link import('@auxify/types').SourceAttribution}.
 *
 * Push → pull reconciliation: the Knowledge_Ingestion_Service ingests a source
 * by *fetching* its documents through a {@link SourceFetcher}, while a native
 * module *pushes* one event per write. The bridge reconciles the two — on each
 * write it stages the content's {@link FetchedDocument} projection in a shared
 * {@link NativeIngestionStagingStore} under the source the content ingests into,
 * then drives an ingest; the {@link StagingSourceFetcher} the
 * Knowledge_Ingestion_Service resolves reads exactly the staged documents back.
 * Content-hash change detection (Req 23.4) then re-indexes only what changed.
 *
 * Resilience (Req 23.8, applied at the wiring boundary): every adapter is
 * fire-and-forget from the writer's perspective — a failure to resolve, stage,
 * read, or ingest is recorded through the injectable
 * {@link IngestionFailureRecorder} and NEVER thrown back to the originating
 * module write, mirroring how each module calls its emitter (the
 * Knowledge_Hub_Service / Messaging_Service / Document_Management_Service
 * `await emitter.emit(...)` after the write has already been persisted).
 *
 * Surface:
 *   - {@link NativeIngestionBridge} — the bridge; exposes {@link NativeIngestionBridge.pages},
 *     {@link NativeIngestionBridge.messages}, and {@link NativeIngestionBridge.documents}
 *     to wire into each module.
 *   - {@link createNativeIngestionBridge} — the convenience factory that builds
 *     the staging store, the {@link StagingSourceFetcher}, the
 *     {@link KnowledgeIngestionService}, and the bridge as one consistent unit.
 *   - {@link StagingSourceFetcher} / {@link InMemoryNativeIngestionStagingStore} —
 *     the push→pull seam and its in-memory default.
 *   - {@link ConnectingNativeSourceResolver} — the default
 *     {@link NativeSourceResolver} that lazily connects one source per
 *     (Organization, native type).
 *   - {@link ObjectStoreDocumentContentReader} — the default
 *     {@link DocumentContentReader} reading document bytes from the Object_Store.
 *   - {@link noopIngestionFailureRecorder} — the default no-op failure recorder.
 */

import type { TenantContext } from '@auxify/types';

import type { ChunkOptions, Embedder } from '../file-processor/index.js';
import type { DocumentIngestionEmitter, DocumentIngestionEvent } from '../document-management/index.js';
import {
  KnowledgeIngestionService,
  type FetchedDocument,
  type KnowledgeSource,
  type KnowledgeStore,
  type SourceFetcher,
  type SourceFetcherResolver,
} from '../knowledge/index.js';
import type { PageIngestionEmitter, PageIngestionEvent } from '../knowledge-hub/index.js';
import type { MessageIngestionEmitter, MessageIngestionItem } from '../messaging/index.js';
import type { ObjectStore, VectorStore } from '../storage/index.js';

import {
  NATIVE_INGESTION_SOURCE_TYPES,
  defaultNativeModuleSourceType,
  documentIngestionToDocument,
  messageIngestionToDocument,
  pageIngestionToDocument,
  type DocumentContentReader,
  type IngestionFailureRecorder,
  type NativeIngestionFailure,
  type NativeIngestionSourceType,
  type NativeIngestionStagingStore,
  type NativeSourceResolver,
} from './types.js';

/**
 * A {@link IngestionFailureRecorder} that silently drops failures — the default
 * when no recorder is wired.
 *
 * Resilience is the point: an indexing failure must not break the originating
 * write (Req 23.8). The no-op default makes that the zero-config behaviour; a
 * deployment wires a real recorder (logging / monitoring / retry queue) to
 * observe the (rare) failures.
 */
export const noopIngestionFailureRecorder: IngestionFailureRecorder = {
  record: () => {
    /* intentionally ignore — failures must never break the originating write */
  },
};

/** Compose the in-memory staging key for a document. */
function stagingKey(organizationId: string, sourceId: string, externalId: string): string {
  return `${organizationId}\u0000${sourceId}\u0000${externalId}`;
}

/** Clone a fetched document so stored staging state can never be mutated by callers. */
function cloneDocument(document: FetchedDocument): FetchedDocument {
  return {
    externalId: document.externalId,
    title: document.title,
    content: document.content,
    ...(document.location !== undefined ? { location: document.location } : {}),
    ...(document.link !== undefined ? { link: document.link } : {}),
  };
}

/** A staged document with the scope and source it belongs to. */
interface StagedEntry {
  /** The Organization the document is scoped to. */
  organizationId: string;
  /** The knowledge source the document ingests into. */
  sourceId: string;
  /** The staged fetched-document projection. */
  document: FetchedDocument;
}

/**
 * The in-memory {@link NativeIngestionStagingStore} default — the push→pull
 * buffer the bridge writes and the {@link StagingSourceFetcher} reads.
 *
 * Entries are confined to their Organization and upserted by `externalId`, so a
 * re-write of the same page/message/document replaces its prior staged copy and
 * the source's full document set is always fetchable for content-hash change
 * detection (Req 23.4). Insertion order is preserved across upserts.
 */
export class InMemoryNativeIngestionStagingStore implements NativeIngestionStagingStore {
  private readonly entries = new Map<string, StagedEntry>();

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async stage(ctx: TenantContext, sourceId: string, document: FetchedDocument): Promise<void> {
    this.entries.set(stagingKey(ctx.organizationId, sourceId, document.externalId), {
      organizationId: ctx.organizationId,
      sourceId,
      document: cloneDocument(document),
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- in-memory fake
  async list(ctx: TenantContext, sourceId: string): Promise<FetchedDocument[]> {
    return [...this.entries.values()]
      .filter(
        (entry) => entry.organizationId === ctx.organizationId && entry.sourceId === sourceId,
      )
      .map((entry) => cloneDocument(entry.document));
  }

  /** The number of staged documents across every Organization (test inspection). */
  get count(): number {
    return this.entries.size;
  }
}

/**
 * The {@link SourceFetcher} the Knowledge_Ingestion_Service resolves for the
 * native source types, reading the documents the {@link NativeIngestionBridge}
 * staged (Req 26.8, 27.9, 28.5).
 *
 * It closes the push→pull loop: the bridge stages a write's
 * {@link FetchedDocument} in the shared {@link NativeIngestionStagingStore} and
 * triggers an ingest; the service then fetches the source's documents through
 * this fetcher, which returns exactly the staged set, and indexes the new/changed
 * ones.
 */
export class StagingSourceFetcher implements SourceFetcher {
  constructor(private readonly staging: NativeIngestionStagingStore) {}

  async fetch(ctx: TenantContext, source: KnowledgeSource): Promise<FetchedDocument[]> {
    return this.staging.list(ctx, source.id);
  }
}

/** Construction options for the {@link ConnectingNativeSourceResolver}. */
export interface ConnectingNativeSourceResolverOptions {
  /** The ingestion service used to connect a source per (Organization, native type). */
  ingestion: KnowledgeIngestionService;
  /**
   * The collection a native type's source is connected under. Either a fixed
   * collection id, or a function resolving one per Organization + type (so a
   * deployment can route each module's content into a dedicated collection).
   */
  collectionId: string | ((ctx: TenantContext, type: NativeIngestionSourceType) => string);
}

/**
 * The default {@link NativeSourceResolver}: lazily connects (and memoizes) one
 * knowledge source per (Organization, native type) through the
 * {@link KnowledgeIngestionService} (Req 26.8, 27.9, 28.5).
 *
 * The first write of a given native type in an Organization connects its source;
 * subsequent writes reuse it. The pending connection is memoized so concurrent
 * first writes share a single `connectSource`, and a failed connection is
 * evicted so a later write can retry.
 */
export class ConnectingNativeSourceResolver implements NativeSourceResolver {
  private readonly ingestion: KnowledgeIngestionService;
  private readonly collectionId:
    | string
    | ((ctx: TenantContext, type: NativeIngestionSourceType) => string);
  private readonly pending = new Map<string, Promise<string>>();

  constructor(options: ConnectingNativeSourceResolverOptions) {
    this.ingestion = options.ingestion;
    this.collectionId = options.collectionId;
  }

  async resolveSourceId(ctx: TenantContext, type: NativeIngestionSourceType): Promise<string> {
    const key = `${ctx.organizationId}\u0000${type}`;
    let pending = this.pending.get(key);
    if (pending === undefined) {
      pending = this.connect(ctx, type).catch((error: unknown) => {
        // Evict the failed connection so a later write can retry rather than
        // permanently caching a rejected promise.
        this.pending.delete(key);
        throw error;
      });
      this.pending.set(key, pending);
    }
    return pending;
  }

  /** Connect a fresh source for the native type within the Organization. */
  private async connect(ctx: TenantContext, type: NativeIngestionSourceType): Promise<string> {
    const collectionId =
      typeof this.collectionId === 'function' ? this.collectionId(ctx, type) : this.collectionId;
    const source = await this.ingestion.connectSource(ctx, { collectionId, type });
    return source.id;
  }
}

/**
 * The default {@link DocumentContentReader}: reads a document's indexable text
 * from its stored bytes in the shared Object_Store (Req 28.5).
 *
 * A {@link DocumentIngestionEvent} carries only the Object_Store key of the
 * stored bytes, so this reads them back and decodes them as UTF-8 text. A
 * production deployment can inject a reader backed by the File_Processor's
 * format-aware text extraction instead.
 */
export class ObjectStoreDocumentContentReader implements DocumentContentReader {
  constructor(private readonly objects: ObjectStore) {}

  async read(_ctx: TenantContext, event: DocumentIngestionEvent): Promise<string> {
    const bytes = await this.objects.get(event.objectKey);
    return new TextDecoder().decode(bytes);
  }
}

/** Construction dependencies for the {@link NativeIngestionBridge}. */
export interface NativeIngestionBridgeOptions {
  /** The Knowledge_Ingestion_Service each write is forwarded to (Req 26.8, 27.9, 28.5). */
  ingestion: KnowledgeIngestionService;
  /** Resolves the knowledge source each native content type ingests into. */
  sources: NativeSourceResolver;
  /** The push→pull staging buffer the bridge writes and the fetcher reads. */
  staging: NativeIngestionStagingStore;
  /** Resolves a document's indexable text from its stored bytes (Req 28.5). */
  documentContent: DocumentContentReader;
  /** Records an indexing failure instead of throwing it back to the writer (Req 23.8). */
  failureRecorder?: IngestionFailureRecorder;
}

/**
 * The native-module ingestion bridge: concrete adapters that forward each native
 * write to the Knowledge_Ingestion_Service so the content becomes a retrievable,
 * attributed `knowledge_chunk` record (Req 26.8, 27.9, 28.5).
 *
 * Wire {@link pages} into the Knowledge_Hub_Service's `ingestion` port,
 * {@link messages} into the Messaging_Service's `ingestion` port, and
 * {@link documents} into the Document_Management_Service's `ingestion` port. Each
 * adapter is resilient: a failure never propagates back to the originating write
 * (Req 23.8).
 */
export class NativeIngestionBridge {
  private readonly ingestion: KnowledgeIngestionService;
  private readonly sources: NativeSourceResolver;
  private readonly staging: NativeIngestionStagingStore;
  private readonly documentContent: DocumentContentReader;
  private readonly failures: IngestionFailureRecorder;

  /** The {@link PageIngestionEmitter} adapter for the Knowledge_Hub_Service (Req 26.8). */
  readonly pages: PageIngestionEmitter;
  /** The {@link MessageIngestionEmitter} adapter for the Messaging_Service (Req 27.9). */
  readonly messages: MessageIngestionEmitter;
  /** The {@link DocumentIngestionEmitter} adapter for the Document_Management_Service (Req 28.5). */
  readonly documents: DocumentIngestionEmitter;

  constructor(options: NativeIngestionBridgeOptions) {
    this.ingestion = options.ingestion;
    this.sources = options.sources;
    this.staging = options.staging;
    this.documentContent = options.documentContent;
    this.failures = options.failureRecorder ?? noopIngestionFailureRecorder;

    this.pages = {
      emit: (ctx: TenantContext, event: PageIngestionEvent): Promise<void> =>
        this.forward(ctx, defaultNativeModuleSourceType.page, event.pageId, () =>
          pageIngestionToDocument(event),
        ),
    };
    this.messages = {
      emit: (ctx: TenantContext, item: MessageIngestionItem): Promise<void> =>
        this.forward(ctx, defaultNativeModuleSourceType.message, item.messageId, () =>
          messageIngestionToDocument(item),
        ),
    };
    this.documents = {
      emit: (ctx: TenantContext, event: DocumentIngestionEvent): Promise<void> =>
        this.forward(ctx, defaultNativeModuleSourceType.document, event.documentId, async () =>
          documentIngestionToDocument(event, await this.documentContent.read(ctx, event)),
        ),
    };
  }

  /**
   * Forward one native write to the Knowledge_Ingestion_Service, resiliently
   * (Req 26.8, 27.9, 28.5, 23.8).
   *
   * Resolves the destination source, builds the content's
   * {@link FetchedDocument} projection (the `build` factory may read bytes,
   * inside the try), stages it, and drives an ingest. ANY failure along the way
   * is recorded through the {@link IngestionFailureRecorder} and swallowed, so
   * the originating module write is never broken by an indexing failure.
   */
  private async forward(
    ctx: TenantContext,
    type: NativeIngestionSourceType,
    externalId: string,
    build: () => FetchedDocument | Promise<FetchedDocument>,
  ): Promise<void> {
    try {
      const sourceId = await this.sources.resolveSourceId(ctx, type);
      const document = await build();
      await this.staging.stage(ctx, sourceId, document);
      await this.ingestion.ingest(ctx, sourceId);
    } catch (error) {
      await this.recordFailure({
        type,
        externalId,
        organizationId: ctx.organizationId,
        error: errorMessage(error),
      });
    }
  }

  /** Record a failure, swallowing any error the recorder itself raises (Req 23.8). */
  private async recordFailure(failure: NativeIngestionFailure): Promise<void> {
    try {
      await this.failures.record(failure);
    } catch {
      // A failure recorder that itself fails must never break the write.
    }
  }
}

/** Construction options for {@link createNativeIngestionBridge}. */
export interface CreateNativeIngestionBridgeOptions {
  /** Tenant-scoped persistence for knowledge sources, documents, and chunks (Req 23.3). */
  store: KnowledgeStore;
  /** Embeds chunk texts into vectors (Req 23.3); reused from the File_Processor. */
  embedder: Embedder;
  /** Indexes chunk embeddings as `knowledge_chunk` Vector_Store records (Req 23.3). */
  vectorStore: VectorStore;
  /**
   * The collection each native type's source is connected under — a fixed id or
   * a per-(Organization, type) resolver. Used by the default
   * {@link ConnectingNativeSourceResolver}.
   */
  collectionId: string | ((ctx: TenantContext, type: NativeIngestionSourceType) => string);
  /**
   * Resolves a document's indexable text (Req 28.5). Provide this, or an
   * {@link CreateNativeIngestionBridgeOptions.objectStore} to use the default
   * {@link ObjectStoreDocumentContentReader}.
   */
  documentContent?: DocumentContentReader;
  /** The Object_Store backing the default {@link ObjectStoreDocumentContentReader}. */
  objectStore?: ObjectStore;
  /** Records indexing failures instead of throwing them to the writer (Req 23.8). */
  failureRecorder?: IngestionFailureRecorder;
  /** Chunk size / overlap tuning forwarded to the {@link KnowledgeIngestionService}. */
  chunkOptions?: ChunkOptions;
  /**
   * An optional base {@link SourceFetcherResolver} the staging fetcher is
   * overlaid on, so a deployment whose Knowledge_Ingestion_Service also serves
   * non-native sources (upload, GitHub, …) keeps those fetchers.
   */
  baseFetchers?: SourceFetcherResolver;
}

/** The consistently-wired native-ingestion unit returned by {@link createNativeIngestionBridge}. */
export interface NativeIngestionWiring {
  /** The bridge whose adapters wire into the three native modules. */
  bridge: NativeIngestionBridge;
  /** The Knowledge_Ingestion_Service the bridge forwards to (also serves RAG retrieval). */
  ingestion: KnowledgeIngestionService;
  /** The shared push→pull staging buffer (test inspection / production replacement). */
  staging: NativeIngestionStagingStore;
  /** The native-source resolver (lazily connects one source per Organization + type). */
  sources: NativeSourceResolver;
}

/**
 * Build a consistently-wired {@link NativeIngestionBridge} together with the
 * {@link KnowledgeIngestionService} that backs it (Req 26.8, 27.9, 28.5).
 *
 * This factory owns the delicate coupling the bridge depends on: it creates the
 * shared {@link NativeIngestionStagingStore}, registers a
 * {@link StagingSourceFetcher} over it for every native source type in the
 * {@link KnowledgeIngestionService}'s fetcher resolver, and constructs the
 * service and bridge against the SAME staging store — so a staged write is
 * exactly what the service fetches and indexes. The returned
 * {@link NativeIngestionWiring.ingestion} is the same service the RAG_Retriever
 * and Unified_Search knowledge searcher read from, so native content indexed
 * here is immediately retrievable.
 *
 * @param options The persistence/embedding/vector ports plus collection routing.
 * @returns The wired bridge, ingestion service, staging store, and source resolver.
 */
export function createNativeIngestionBridge(
  options: CreateNativeIngestionBridgeOptions,
): NativeIngestionWiring {
  const staging = new InMemoryNativeIngestionStagingStore();
  const stagingFetcher = new StagingSourceFetcher(staging);
  const nativeTypes = new Set<string>(NATIVE_INGESTION_SOURCE_TYPES);

  const fetchers: SourceFetcherResolver = {
    resolve: (type) =>
      nativeTypes.has(type) ? stagingFetcher : options.baseFetchers?.resolve(type),
  };

  const ingestion = new KnowledgeIngestionService({
    store: options.store,
    fetchers,
    embedder: options.embedder,
    vectorStore: options.vectorStore,
    ...(options.chunkOptions !== undefined ? { chunkOptions: options.chunkOptions } : {}),
  });

  const documentContent = resolveDocumentContentReader(options);
  const sources = new ConnectingNativeSourceResolver({
    ingestion,
    collectionId: options.collectionId,
  });

  const bridge = new NativeIngestionBridge({
    ingestion,
    sources,
    staging,
    documentContent,
    ...(options.failureRecorder !== undefined ? { failureRecorder: options.failureRecorder } : {}),
  });

  return { bridge, ingestion, staging, sources };
}

/** Resolve the document content reader from the factory options (explicit, else Object_Store-backed). */
function resolveDocumentContentReader(
  options: CreateNativeIngestionBridgeOptions,
): DocumentContentReader {
  if (options.documentContent !== undefined) {
    return options.documentContent;
  }
  if (options.objectStore !== undefined) {
    return new ObjectStoreDocumentContentReader(options.objectStore);
  }
  throw new Error(
    'createNativeIngestionBridge: provide either `documentContent` or `objectStore` for document text resolution (Req 28.5)',
  );
}

/** A safe, secret-free message for a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
