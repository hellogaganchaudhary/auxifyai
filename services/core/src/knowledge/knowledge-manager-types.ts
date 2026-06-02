/**
 * Domain records and injectable ports for the Knowledge_Manager (Req 25.1-25.5).
 *
 * The Knowledge_Manager is the administration side of the knowledge module: it
 * organizes a `knowledge_collection` over the sources the
 * {@link import('./knowledge-ingestion-service.js').KnowledgeIngestionService}
 * ingests into, controls which Teams and Projects may retrieve from a
 * collection (Req 25.2 — the access model the RAG_Retriever's
 * {@link import('./rag-types.js').ChunkAuthorizer} composes, see
 * `./knowledge-access.js`), surfaces each source's sync status for a dashboard
 * (Req 25.3), flags duplicate content within a collection (Req 25.4), and marks
 * documents stale once they fall outside a configured freshness window
 * (Req 25.5).
 *
 * It deliberately reuses the ingestion module's {@link KnowledgeSource} and
 * {@link KnowledgeDocumentRecord} rather than redefining them, and models its
 * one external capability — tenant-scoped persistence of collections plus the
 * source/document reads and the duplicate/stale flag writes — as the narrow
 * {@link KnowledgeCollectionStore} port. The manager is therefore pure
 * orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`, with no hard dependency on a database.
 */

import type { TenantContext } from '@auxify/types';

import type {
  KnowledgeDocumentRecord,
  KnowledgeSource,
  KnowledgeSourceType,
  SyncMode,
  SyncStatus,
} from './types.js';

/**
 * Whether a collection is owned by a Team or a Project (mirrors the
 * `knowledge_collections.owner_scope` column) (Req 25.1).
 */
export type CollectionOwnerScope = 'team' | 'project';

/** All {@link CollectionOwnerScope} values, for iteration, validation, and tests. */
export const COLLECTION_OWNER_SCOPES: readonly CollectionOwnerScope[] = [
  'team',
  'project',
] as const;

/**
 * The default freshness window in milliseconds before a document is considered
 * stale (Req 25.5): 30 days.
 *
 * A document whose last update is older than `now - freshnessWindowMs` is marked
 * stale by {@link import('./knowledge-manager.js').KnowledgeManager.markStale}.
 * The window is configurable per-manager and overridable per call so different
 * collections can hold knowledge to different freshness standards.
 */
export const DEFAULT_FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A knowledge collection (mirrors the `knowledge_collections` row) (Req 25.1,
 * 25.2).
 *
 * A collection is owned by exactly one Team or Project ({@link ownerScope} /
 * {@link ownerScopeId}) and carries the access lists that restrict retrieval to
 * members of the permitted Teams and Projects (Req 25.2). It is tenant-scoped
 * through the {@link KnowledgeCollectionStore}: a collection is reachable only
 * within its owning Organization (Req 1.2).
 */
export interface KnowledgeCollection {
  /** The collection's stable unique id. */
  id: string;
  /** The Organization that owns the collection (tenant scope, Req 1.2). */
  organizationId: string;
  /** Whether the collection is owned by a Team or a Project (Req 25.1). */
  ownerScope: CollectionOwnerScope;
  /** The id of the owning Team or Project (Req 25.1). */
  ownerScopeId: string;
  /** The collection's human-readable name (Req 25.1). */
  name: string;
  /** The Teams permitted to retrieve from the collection (Req 25.2). */
  allowedTeams: string[];
  /** The Projects permitted to retrieve from the collection (Req 25.2). */
  allowedProjects: string[];
  /** The ISO-8601 timestamp the collection was created. */
  createdAt: string;
}

/**
 * The fields a caller supplies to
 * {@link import('./knowledge-manager.js').KnowledgeManager.createCollection}
 * (Req 25.1).
 *
 * The owning Organization is taken from the caller's {@link TenantContext}; the
 * access lists default to empty (no Team/Project granted beyond the owner) and
 * can be set later with
 * {@link import('./knowledge-manager.js').KnowledgeManager.setAccess}. An
 * explicit {@link id} can be supplied for deterministic tests; otherwise the
 * manager generates one.
 */
export interface CreateCollectionInput {
  /** The collection name (Req 25.1). */
  name: string;
  /** Whether the collection is owned by a Team or a Project (Req 25.1). */
  ownerScope: CollectionOwnerScope;
  /** The id of the owning Team or Project (Req 25.1). */
  ownerScopeId: string;
  /** The Teams initially permitted to retrieve (defaults to empty) (Req 25.2). */
  allowedTeams?: string[];
  /** The Projects initially permitted to retrieve (defaults to empty) (Req 25.2). */
  allowedProjects?: string[];
  /** An explicit collection id (defaults to a generated id). */
  id?: string;
}

/**
 * A source's status line for the source-status dashboard (Req 25.3).
 *
 * Projects the dashboard-relevant fields of a {@link KnowledgeSource} — its sync
 * status, last sync time, and indexed document count — so the Knowledge_Manager
 * can report each source's state without exposing the full record.
 */
export interface SourceStatus {
  /** The source's id. */
  sourceId: string;
  /** The kind of source (native or optional connector). */
  type: KnowledgeSourceType;
  /** How the source is kept in sync. */
  syncMode: SyncMode;
  /** The state of the source's most recent sync (Req 25.3). */
  syncStatus: SyncStatus;
  /** The ISO-8601 timestamp of the last completed sync, or `null` if never synced (Req 25.3). */
  lastSyncAt: string | null;
  /** The number of documents currently indexed for the source (Req 25.3). */
  documentCount: number;
}

/**
 * A document flagged as a duplicate of an earlier, canonical document within
 * the same collection (Req 25.4).
 *
 * The Knowledge_Manager treats the earliest document sharing a content hash as
 * the canonical copy and points every later copy at it via
 * {@link KnowledgeDocumentRecord.duplicateOf}. One {@link DuplicateFlag} is
 * returned per newly flagged duplicate.
 */
export interface DuplicateFlag {
  /** The id of the document flagged as a duplicate. */
  documentId: string;
  /** The id of the canonical document it duplicates (Req 25.4). */
  duplicateOf: string;
  /** The shared content hash that identified the duplication (Req 23.4, 25.4). */
  contentHash: string;
  /** The source the duplicate document belongs to. */
  sourceId: string;
}

/**
 * A document marked (or already) stale because it has not been updated within
 * the configured freshness window (Req 25.5).
 *
 * Returned by the Knowledge_Manager's stale-document surface so a dashboard can
 * list the knowledge that needs refreshing.
 */
export interface StaleDocument {
  /** The id of the stale document. */
  documentId: string;
  /** The source the document belongs to. */
  sourceId: string;
  /** The document's title. */
  title: string;
  /** The ISO-8601 timestamp of the document's last update (Req 25.5). */
  updatedAt: string;
}

/**
 * The tenant-scoped persistence port the Knowledge_Manager composes (Req 25.1-25.5).
 *
 * Every method takes the caller's {@link TenantContext} so persistence is
 * automatically scoped to the Organization (Req 1.2) — the manager never
 * touches a backend directly. The concrete implementation is the tenant-scoped
 * repository layer over `knowledge_collections` / `knowledge_sources` /
 * `knowledge_documents`; tests substitute the in-memory
 * {@link import('./fakes.js').InMemoryKnowledgeCollectionStore}.
 *
 * Source and document *reads* reuse the same {@link KnowledgeSource} and
 * {@link KnowledgeDocumentRecord} shapes the Knowledge_Ingestion_Service writes,
 * so the two services share one persistence model.
 */
export interface KnowledgeCollectionStore {
  /** Persist a new collection and return it (Req 25.1). */
  createCollection(
    ctx: TenantContext,
    collection: KnowledgeCollection,
  ): Promise<KnowledgeCollection>;

  /** Return a collection by id within the tenant scope, or `null` when absent. */
  getCollection(ctx: TenantContext, collectionId: string): Promise<KnowledgeCollection | null>;

  /**
   * Replace a collection's access lists and return the updated collection, or
   * `null` when no collection matches within the tenant scope (Req 25.2).
   */
  setCollectionAccess(
    ctx: TenantContext,
    collectionId: string,
    allowedTeams: string[],
    allowedProjects: string[],
  ): Promise<KnowledgeCollection | null>;

  /** Return the collection that owns a source, or `null` when absent (Req 25.2). */
  getCollectionForSource(
    ctx: TenantContext,
    sourceId: string,
  ): Promise<KnowledgeCollection | null>;

  /** Return a collection's sources within the tenant scope (Req 25.3). */
  listSourcesByCollection(
    ctx: TenantContext,
    collectionId: string,
  ): Promise<KnowledgeSource[]>;

  /** Return every document across a collection's sources within the tenant scope (Req 25.4, 25.5). */
  listDocumentsByCollection(
    ctx: TenantContext,
    collectionId: string,
  ): Promise<KnowledgeDocumentRecord[]>;

  /**
   * Point a document at the canonical document it duplicates and return the
   * updated record, or `null` when no document matches within the tenant scope
   * (Req 25.4).
   */
  setDocumentDuplicate(
    ctx: TenantContext,
    documentId: string,
    duplicateOf: string,
  ): Promise<KnowledgeDocumentRecord | null>;

  /**
   * Set a document's stale flag and return the updated record, or `null` when
   * no document matches within the tenant scope (Req 25.5).
   */
  setDocumentStale(
    ctx: TenantContext,
    documentId: string,
    stale: boolean,
  ): Promise<KnowledgeDocumentRecord | null>;
}

/** A unique-id source for new collections, injectable for deterministic tests. */
export interface CollectionIdGenerator {
  /** Return a new unique id. */
  (): string;
}

/** A clock returning the current time, injectable for deterministic tests. */
export interface KnowledgeManagerClock {
  /** Return the current time. */
  (): Date;
}

/** Per-call tuning for the stale-document marking operation (Req 25.5). */
export interface MarkStaleOptions {
  /** The freshness window in milliseconds for this call (defaults to the manager's window). */
  freshnessWindowMs?: number;
  /** The instant to evaluate freshness against (defaults to the manager's clock). */
  asOf?: Date;
}
