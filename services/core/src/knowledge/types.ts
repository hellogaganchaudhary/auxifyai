/**
 * Domain records and injectable ports for the Knowledge_Ingestion_Service
 * (Req 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8, 23.9).
 *
 * The Knowledge_Ingestion_Service is the pipeline that turns a connected
 * knowledge source into retrievable, attributed knowledge. It supports the
 * platform's primary native sources — direct file upload, native
 * Knowledge_Hub_Service pages, native Document_Management_Service documents,
 * native Messaging_Service content, GitHub repositories, email, and web URLs
 * (Req 23.1) — and, only where an Organization enables them, optional
 * interoperability connectors (Notion, Confluence, Google Drive, SharePoint)
 * that are never required for platform operation (Req 23.2). For every source
 * it parses each document, splits it into chunks, embeds each chunk, and
 * indexes the chunks in the Vector_Store (Req 23.3), using a content hash to
 * re-index only changed documents (Req 23.4).
 *
 * Every external capability the service cannot perform purely — fetching a
 * source's documents, embedding chunk text, hashing content, and persisting
 * sources / documents / chunks — is modelled here as a narrow port, and the
 * durable vector side effects go through the shared
 * {@link import('../storage/index.js').VectorStore} interface. The chunking and
 * embedding contracts are deliberately reused from the File_Processor
 * ({@link import('../file-processor/index.js').chunkText},
 * {@link import('../file-processor/index.js').Embedder}) so the platform has a
 * single chunk/embed pipeline. The service is therefore pure orchestration and
 * fully unit-testable with the in-memory fakes in `./fakes.js`, with no hard
 * dependency on a connector SDK, an embedding model, or a database.
 */

import type { SourceAttribution, TenantContext } from '@auxify/types';

/**
 * The primary native knowledge sources every Organization can ingest from
 * without enabling any external product (Req 23.1).
 *
 * These map onto the platform's own modules and first-class integrations:
 * direct file upload, Knowledge_Hub_Service pages, Document_Management_Service
 * documents, Messaging_Service content, GitHub repositories, email, and web
 * URLs. They are always available and are the platform's authoritative
 * knowledge source.
 */
export type NativeSourceType =
  | 'upload'
  | 'knowledge_hub'
  | 'dms'
  | 'messaging'
  | 'github'
  | 'email'
  | 'web_url';

/** All {@link NativeSourceType} values, for iteration, validation, and tests. */
export const NATIVE_SOURCE_TYPES: readonly NativeSourceType[] = [
  'upload',
  'knowledge_hub',
  'dms',
  'messaging',
  'github',
  'email',
  'web_url',
] as const;

/**
 * The optional interoperability connectors an Organization may enable (Req 23.2).
 *
 * These ingest from external products and are deliberately optional: when a
 * connector is unavailable the platform keeps serving native sources without
 * interruption (Req 23.9). They are never required for platform operation.
 */
export type ConnectorSourceType = 'notion' | 'confluence' | 'google_drive' | 'sharepoint';

/** All {@link ConnectorSourceType} values, for iteration, validation, and tests. */
export const CONNECTOR_SOURCE_TYPES: readonly ConnectorSourceType[] = [
  'notion',
  'confluence',
  'google_drive',
  'sharepoint',
] as const;

/** Any source type the Knowledge_Ingestion_Service can ingest (Req 23.1, 23.2). */
export type KnowledgeSourceType = NativeSourceType | ConnectorSourceType;

/** True iff `type` is one of the optional external connectors (Req 23.2, 23.9). */
export function isConnectorSourceType(type: KnowledgeSourceType): type is ConnectorSourceType {
  return (CONNECTOR_SOURCE_TYPES as readonly string[]).includes(type);
}

/** True iff `type` is one of the primary native sources (Req 23.1). */
export function isNativeSourceType(type: KnowledgeSourceType): type is NativeSourceType {
  return (NATIVE_SOURCE_TYPES as readonly string[]).includes(type);
}

/**
 * How a source is kept in sync (mirrors the `knowledge_sources.sync_mode`
 * column).
 *
 * `realtime` ingests on a change notification (Req 23.5); `scheduled` ingests at
 * a configured cadence (Req 23.6); `manual` ingests only on an explicit
 * re-index (Req 23.7).
 */
export type SyncMode = 'realtime' | 'scheduled' | 'manual';

/** All {@link SyncMode} values, for iteration, validation, and tests. */
export const SYNC_MODES: readonly SyncMode[] = ['realtime', 'scheduled', 'manual'] as const;

/**
 * The lifecycle state of a source's most recent sync (mirrors the
 * `knowledge_sources.sync_status` column).
 *
 * `error` indicates the last sync ended with at least one failed document; the
 * service still records each failure and continues (Req 23.8).
 */
export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

/**
 * A connected knowledge source (mirrors the `knowledge_sources` row).
 *
 * A source belongs to a knowledge collection within an Organization and is
 * tenant-scoped through the {@link KnowledgeStore}. Its sync bookkeeping
 * ({@link syncStatus}, {@link lastSyncAt}, {@link documentCount}) is updated by
 * the Knowledge_Ingestion_Service after each ingest and surfaced by the
 * Knowledge_Manager (Req 25.3).
 */
export interface KnowledgeSource {
  /** The source's stable unique id. */
  id: string;
  /** The collection the source belongs to. */
  collectionId: string;
  /** The kind of source (native or optional connector). */
  type: KnowledgeSourceType;
  /** How the source is kept in sync (Req 23.5, 23.6, 23.7). */
  syncMode: SyncMode;
  /** The state of the source's most recent sync. */
  syncStatus: SyncStatus;
  /** The ISO-8601 timestamp of the last completed sync, or `null` if never synced. */
  lastSyncAt: string | null;
  /** The number of documents currently indexed for the source. */
  documentCount: number;
  /** The ISO-8601 timestamp the source was connected. */
  createdAt: string;
}

/**
 * The configuration supplied to
 * {@link import('./knowledge-ingestion-service.js').KnowledgeIngestionService.connectSource}
 * (Req 23.1, 23.2).
 *
 * Carries the owning collection, the source type, and the desired sync mode
 * (defaulting to `manual`). An explicit {@link id} can be supplied for
 * deterministic tests; otherwise the service generates one.
 */
export interface KnowledgeSourceConfig {
  /** The collection the new source belongs to. */
  collectionId: string;
  /** The kind of source to connect (native or optional connector). */
  type: KnowledgeSourceType;
  /** How the source should be kept in sync (defaults to `manual`). */
  syncMode?: SyncMode;
  /** An explicit source id (defaults to a generated id). */
  id?: string;
}

/**
 * A single document fetched from a source, ready to be parsed → chunked →
 * embedded → indexed (Req 23.3).
 *
 * {@link externalId} is the document's stable identity *within* the source, used
 * to match the document across syncs for content-hash change detection
 * (Req 23.4); {@link content} is the already-parsed text. {@link location} and
 * {@link link} feed the complete {@link SourceAttribution} attached to every
 * indexed chunk (Req 24.4) so downstream RAG can always cite the source.
 */
export interface FetchedDocument {
  /** The document's stable id within its source (the change-detection key). */
  externalId: string;
  /** The document's human-readable title. */
  title: string;
  /** The parsed document text to chunk and embed. */
  content: string;
  /** Where within the source the document lives (e.g. a path/section), for attribution. */
  location?: string;
  /** A resolvable link back to the document, for attribution. */
  link?: string;
}

/**
 * The port that fetches a source's documents (Req 23.1, 23.2).
 *
 * Modelling fetching as a port keeps the Knowledge_Ingestion_Service
 * independent of every concrete source — a native module repository, the
 * GitHub API, an email mailbox, a web crawler, or an optional connector SDK —
 * and lets tests inject deterministic documents. A connector fetcher signals an
 * unavailable external product by throwing
 * {@link import('./errors.js').ConnectorUnavailableError}, which the service
 * handles gracefully so native sources keep serving (Req 23.9).
 */
export interface SourceFetcher {
  /**
   * Fetch the current documents of a source.
   *
   * @param ctx The tenant scope the source belongs to.
   * @param source The source to fetch documents from.
   * @returns The source's current documents.
   * @throws {import('./errors.js').ConnectorUnavailableError} When an optional connector is unavailable (Req 23.9).
   */
  fetch(ctx: TenantContext, source: KnowledgeSource): Promise<FetchedDocument[]>;
}

/**
 * Resolves the {@link SourceFetcher} registered for a source type.
 *
 * The Knowledge_Ingestion_Service depends on this resolver rather than a fixed
 * set of fetchers so native and connector fetchers can be registered
 * independently (and connectors omitted entirely). A type with no registered
 * fetcher is a configuration gap: for an optional connector it degrades
 * gracefully (Req 23.9), for a native source it is a hard error.
 */
export interface SourceFetcherResolver {
  /**
   * Return the fetcher registered for `type`, or `undefined` when none is.
   *
   * @param type The source type to resolve a fetcher for.
   */
  resolve(type: KnowledgeSourceType): SourceFetcher | undefined;
}

/**
 * The port that derives a content hash for change detection (Req 23.4).
 *
 * The service hashes each fetched document's content and compares it to the
 * stored hash to re-index only changed documents. Modelling hashing as a port
 * keeps the algorithm swappable and the service deterministic in tests; the
 * default is SHA-256 (`./content-hash.js`).
 */
export interface ContentHasher {
  /**
   * Compute a stable content hash for a document's text.
   *
   * @param content The parsed document text.
   * @returns A stable hash string; equal content yields an equal hash.
   */
  hash(content: string): string;
}

/**
 * A persisted knowledge document (mirrors the `knowledge_documents` row).
 *
 * Tenant-scoped through the {@link KnowledgeStore} (a document is reachable only
 * within its source's Organization). {@link externalId} ties the row to the
 * source's document identity across syncs, and {@link contentHash} is the value
 * change detection compares (Req 23.4).
 */
export interface KnowledgeDocumentRecord {
  /** The document's stable unique id (also the owner id of its chunk vectors). */
  id: string;
  /** The source the document belongs to. */
  sourceId: string;
  /** The document's stable id within its source (the change-detection key). */
  externalId: string;
  /** The document's title. */
  title: string;
  /** The hash of the document's content at the last successful index (Req 23.4). */
  contentHash: string;
  /** Whether the document has been marked stale by the Knowledge_Manager (Req 25.5). */
  stale: boolean;
  /**
   * When set, the id of the canonical document this one duplicates within its
   * collection — the Knowledge_Manager flags duplicate content by pointing the
   * later copy at the earlier one (Req 25.4). `undefined` for a document that is
   * not a known duplicate. Mirrors the nullable `knowledge_documents.duplicate_of`
   * column.
   */
  duplicateOf?: string;
  /** The ISO-8601 timestamp of the document's last update. */
  updatedAt: string;
  /** The ISO-8601 timestamp the document was first created. */
  createdAt: string;
}

/** The fields needed to create or update a {@link KnowledgeDocumentRecord}. */
export interface SaveDocumentInput {
  /** The id of an existing document to update; omit to create a new one. */
  id?: string;
  /** The source the document belongs to. */
  sourceId: string;
  /** The document's stable id within its source. */
  externalId: string;
  /** The document's title. */
  title: string;
  /** The content hash at this index (Req 23.4). */
  contentHash: string;
}

/**
 * A persisted knowledge chunk (mirrors the `knowledge_chunks` row).
 *
 * Each chunk carries its complete {@link SourceAttribution} (Req 24.4) and the
 * id of the {@link import('../storage/index.js').VectorStore} record that holds
 * its embedding, so re-indexing a changed document can delete exactly the prior
 * vectors before writing the new ones.
 */
export interface KnowledgeChunkRecord {
  /** The chunk's stable unique id (also its Vector_Store record id). */
  id: string;
  /** The document the chunk belongs to. */
  documentId: string;
  /** The chunk's zero-based position within the document. */
  ordinal: number;
  /** The chunk text. */
  text: string;
  /** The id of the Vector_Store record holding the chunk's embedding. */
  vectorId: string;
  /** The chunk's complete source attribution (Req 24.4). */
  attribution: SourceAttribution;
}

/** A partial update to a source's sync bookkeeping. */
export interface SourceSyncPatch {
  /** The new sync status. */
  syncStatus: SyncStatus;
  /** The ISO-8601 timestamp of the completed sync, when one occurred. */
  lastSyncAt?: string;
  /** The new indexed-document count. */
  documentCount?: number;
}

/**
 * The tenant-scoped persistence port for knowledge sources, documents, and
 * chunks (Req 23.3, 23.4).
 *
 * Every method takes the caller's {@link TenantContext} so persistence is
 * automatically scoped to the Organization (Req 1.2) — the service never
 * touches a backend directly. The concrete implementation is the tenant-scoped
 * repository layer over the `knowledge_*` tables; tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryKnowledgeStore}.
 */
export interface KnowledgeStore {
  /** Persist a new source and return it (Req 23.1, 23.2). */
  createSource(ctx: TenantContext, source: KnowledgeSource): Promise<KnowledgeSource>;

  /** Return a source by id within the tenant scope, or `null` when absent. */
  getSource(ctx: TenantContext, sourceId: string): Promise<KnowledgeSource | null>;

  /** Update a source's sync bookkeeping after an ingest. */
  setSourceSyncState(ctx: TenantContext, sourceId: string, patch: SourceSyncPatch): Promise<void>;

  /** Return a source's documents within the tenant scope. */
  listDocuments(ctx: TenantContext, sourceId: string): Promise<KnowledgeDocumentRecord[]>;

  /** Return a source's document by its source-local external id, or `null`. */
  getDocumentByExternalId(
    ctx: TenantContext,
    sourceId: string,
    externalId: string,
  ): Promise<KnowledgeDocumentRecord | null>;

  /** Create or update a document (keyed by source + external id) and return it. */
  saveDocument(ctx: TenantContext, input: SaveDocumentInput): Promise<KnowledgeDocumentRecord>;

  /** Return a document's persisted chunks within the tenant scope. */
  listChunks(ctx: TenantContext, documentId: string): Promise<KnowledgeChunkRecord[]>;

  /** Replace a document's chunks wholesale (delete prior, insert new). */
  replaceChunks(
    ctx: TenantContext,
    documentId: string,
    chunks: KnowledgeChunkRecord[],
  ): Promise<void>;
}

/** The discriminant statuses ingesting a single document can produce. */
export type DocumentIngestStatus = 'indexed' | 'unchanged' | 'failed';

/**
 * A document that was parsed, chunked, embedded, and indexed in this run
 * (Req 23.3) — either new or changed since the last sync (Req 23.4).
 */
export interface IndexedDocument {
  /** Discriminant: the document was (re-)indexed. */
  status: 'indexed';
  /** The document's source-local external id. */
  externalId: string;
  /** The persisted document's id. */
  documentId: string;
  /** The document's title. */
  title: string;
  /** The number of chunks the content was split into (Req 23.3). */
  chunkCount: number;
  /** The ids of the Vector_Store records created for the chunks. */
  vectorIds: string[];
  /** The content hash recorded for the document (Req 23.4). */
  contentHash: string;
}

/**
 * A document skipped because its content hash matched the stored hash and the
 * run was not a forced re-index — re-indexing only changed documents (Req 23.4).
 */
export interface UnchangedDocument {
  /** Discriminant: the document was unchanged and skipped. */
  status: 'unchanged';
  /** The document's source-local external id. */
  externalId: string;
  /** The existing persisted document's id. */
  documentId: string;
  /** The unchanged content hash. */
  contentHash: string;
}

/**
 * A document whose ingest failed; the failure is recorded and the remaining
 * documents continue (Req 23.8).
 */
export interface FailedDocument {
  /** Discriminant: the document failed to ingest. */
  status: 'failed';
  /** The document's source-local external id. */
  externalId: string;
  /** The document's title, when known. */
  title: string;
  /** A safe, human-readable description of the failure. */
  error: string;
}

/** The outcome of ingesting a single document within a source sync. */
export type DocumentIngestOutcome = IndexedDocument | UnchangedDocument | FailedDocument;

/** Whether an ingest ran to completion or short-circuited on an unavailable connector. */
export type IngestRunStatus = 'completed' | 'connector_unavailable';

/**
 * The report returned by the Knowledge_Ingestion_Service's ingest/re-index
 * entry points (Req 23.3, 23.4, 23.8, 23.9).
 *
 * Holds one {@link DocumentIngestOutcome} per fetched document plus reconciled
 * counts. A `connector_unavailable` {@link status} means an optional connector
 * was unavailable and the run produced no document outcomes while native
 * sources keep serving uninterrupted (Req 23.9).
 */
export interface KnowledgeIngestReport {
  /** The source that was ingested. */
  sourceId: string;
  /** Whether the run completed or short-circuited on an unavailable connector (Req 23.9). */
  status: IngestRunStatus;
  /** One outcome per fetched document. */
  documents: DocumentIngestOutcome[];
  /** The number of documents (re-)indexed (Req 23.3, 23.4). */
  indexedCount: number;
  /** The number of unchanged documents skipped (Req 23.4). */
  unchangedCount: number;
  /** The number of documents whose ingest failed but were recorded (Req 23.8). */
  failedCount: number;
}

/**
 * The result of content-hash change detection over a source's documents
 * (Req 23.4), without mutating anything.
 *
 * Used by the service to decide what to re-index and exposed so callers (e.g. a
 * scheduler) can inspect pending work. {@link removed} lists stored documents no
 * longer present at the source.
 */
export interface KnowledgeChangeSet {
  /** The source the change set was computed for. */
  sourceId: string;
  /** External ids of documents present at the source but not yet stored. */
  added: string[];
  /** External ids of stored documents whose content hash changed. */
  changed: string[];
  /** External ids of stored documents whose content hash is unchanged. */
  unchanged: string[];
  /** External ids of stored documents no longer present at the source. */
  removed: string[];
}
