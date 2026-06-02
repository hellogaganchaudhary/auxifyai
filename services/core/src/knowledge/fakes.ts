/**
 * Test fakes for the Knowledge_Ingestion_Service (Req 23.1-23.9).
 *
 * Each injectable port has a small, deterministic in-memory implementation so
 * the service's orchestration — source connection, document fetching,
 * content-hash change detection, chunk/embed/index, per-document failure
 * resilience, and graceful connector degradation — can be unit-tested without a
 * real connector SDK, embedding model, or database:
 *
 *  - {@link InMemoryKnowledgeStore} persists sources, documents, and chunks in
 *    Maps, scoped by the {@link TenantContext} Organization so cross-tenant
 *    reads return nothing (Req 1.2).
 *  - {@link FakeSourceFetcher} returns seeded {@link FetchedDocument}s for a
 *    source and can be flagged to throw {@link ConnectorUnavailableError}
 *    (Req 23.9) or an arbitrary error to exercise per-document resilience
 *    (Req 23.8).
 *  - {@link MapSourceFetcherResolver} resolves a fetcher per source type, with
 *    types left unregistered to model an unconfigured connector.
 *  - {@link DeterministicEmbedder} from the File_Processor fakes is reused as
 *    the embedder so the 1536-dim Vector_Store contract holds.
 *
 * The durable vector side effects reuse the spec-faithful
 * {@link InMemoryVectorStore} from the storage layer.
 *
 * For the RAG_Retriever (Req 24.1-24.7) two further fakes model the chunk
 * authorization port (Req 24.3):
 *
 *  - {@link AllowAllChunkAuthorizer} authorizes every chunk, for tests that
 *    exercise ranking/attribution without an access constraint;
 *  - {@link SourceScopedChunkAuthorizer} authorizes only chunks from an
 *    explicit allow-list of source ids, modelling collection/source access
 *    restriction (Req 24.3, 25.2).
 */

import type { Principal, TenantContext } from '@auxify/types';

import { ConnectorUnavailableError } from './errors.js';
import type { AuditEvent, AuditRecorder } from '../audit/index.js';

import type { ChunkAuthorizer, RetrievableChunk } from './rag-types.js';
import type {
  KnowledgeCollection,
  KnowledgeCollectionStore,
} from './knowledge-manager-types.js';
import type {
  ConnectorSourceType,
  FetchedDocument,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeSource,
  KnowledgeSourceType,
  SaveDocumentInput,
  SourceFetcher,
  SourceFetcherResolver,
  SourceSyncPatch,
  KnowledgeStore,
} from './types.js';

/** A stored document keyed within its Organization, for the in-memory store. */
interface StoredDocEntry {
  /** The Organization the document is scoped to. */
  organizationId: string;
  /** The persisted document record. */
  record: KnowledgeDocumentRecord;
  /** The document's chunks, in ordinal order. */
  chunks: KnowledgeChunkRecord[];
}

/** A stored source keyed within its Organization, for the in-memory store. */
interface StoredSourceEntry {
  /** The Organization the source is scoped to. */
  organizationId: string;
  /** The persisted source record. */
  record: KnowledgeSource;
}

/**
 * An in-memory {@link KnowledgeStore} that scopes every record to the
 * {@link TenantContext} Organization (Req 1.2).
 *
 * A read issued under a different Organization returns nothing, mirroring the
 * tenant-scoped repository the production service uses. Ids are sequential per
 * document so tests can assert exact values.
 */
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly sources = new Map<string, StoredSourceEntry>();
  private readonly documents = new Map<string, StoredDocEntry>();
  private docSeq = 0;

  async createSource(ctx: TenantContext, source: KnowledgeSource): Promise<KnowledgeSource> {
    this.sources.set(source.id, { organizationId: ctx.organizationId, record: { ...source } });
    return { ...source };
  }

  async getSource(ctx: TenantContext, sourceId: string): Promise<KnowledgeSource | null> {
    const entry = this.sources.get(sourceId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return null;
    }
    return { ...entry.record };
  }

  async setSourceSyncState(
    ctx: TenantContext,
    sourceId: string,
    patch: SourceSyncPatch,
  ): Promise<void> {
    const entry = this.sources.get(sourceId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return;
    }
    entry.record.syncStatus = patch.syncStatus;
    if (patch.lastSyncAt !== undefined) {
      entry.record.lastSyncAt = patch.lastSyncAt;
    }
    if (patch.documentCount !== undefined) {
      entry.record.documentCount = patch.documentCount;
    }
  }

  async listDocuments(
    ctx: TenantContext,
    sourceId: string,
  ): Promise<KnowledgeDocumentRecord[]> {
    return [...this.documents.values()]
      .filter(
        (entry) =>
          entry.organizationId === ctx.organizationId && entry.record.sourceId === sourceId,
      )
      .map((entry) => ({ ...entry.record }));
  }

  async getDocumentByExternalId(
    ctx: TenantContext,
    sourceId: string,
    externalId: string,
  ): Promise<KnowledgeDocumentRecord | null> {
    const entry = [...this.documents.values()].find(
      (e) =>
        e.organizationId === ctx.organizationId &&
        e.record.sourceId === sourceId &&
        e.record.externalId === externalId,
    );
    return entry === undefined ? null : { ...entry.record };
  }

  async saveDocument(
    ctx: TenantContext,
    input: SaveDocumentInput,
  ): Promise<KnowledgeDocumentRecord> {
    const timestamp = new Date(0).toISOString();
    if (input.id !== undefined) {
      const entry = this.documents.get(input.id);
      if (entry !== undefined && entry.organizationId === ctx.organizationId) {
        entry.record = {
          ...entry.record,
          title: input.title,
          contentHash: input.contentHash,
          updatedAt: timestamp,
        };
        return { ...entry.record };
      }
    }
    this.docSeq += 1;
    const record: KnowledgeDocumentRecord = {
      id: input.id ?? `kdoc-${this.docSeq}`,
      sourceId: input.sourceId,
      externalId: input.externalId,
      title: input.title,
      contentHash: input.contentHash,
      stale: false,
      updatedAt: timestamp,
      createdAt: timestamp,
    };
    this.documents.set(record.id, {
      organizationId: ctx.organizationId,
      record,
      chunks: [],
    });
    return { ...record };
  }

  async listChunks(ctx: TenantContext, documentId: string): Promise<KnowledgeChunkRecord[]> {
    const entry = this.documents.get(documentId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return [];
    }
    return entry.chunks.map((chunk) => ({ ...chunk }));
  }

  async replaceChunks(
    ctx: TenantContext,
    documentId: string,
    chunks: KnowledgeChunkRecord[],
  ): Promise<void> {
    const entry = this.documents.get(documentId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return;
    }
    entry.chunks = chunks.map((chunk) => ({ ...chunk }));
  }

  /** Total number of documents stored, for test assertions. */
  documentCount(): number {
    return this.documents.size;
  }
}

/**
 * A {@link SourceFetcher} fake returning seeded documents for each source id
 * (Req 23.1, 23.2).
 *
 * Seed documents per source with {@link setDocuments}; flag a source to throw
 * {@link ConnectorUnavailableError} with {@link failConnector} to exercise
 * graceful degradation (Req 23.9), or throw an arbitrary error for a specific
 * document with {@link failDocument} to exercise per-document resilience
 * (Req 23.8).
 */
export class FakeSourceFetcher implements SourceFetcher {
  /** Every source id passed to {@link fetch}, in order. */
  readonly calls: string[] = [];
  private readonly docs = new Map<string, FetchedDocument[]>();
  private readonly unavailable = new Map<string, ConnectorSourceType>();

  /** Seed the documents a source (by id) fetches. */
  setDocuments(sourceId: string, docs: FetchedDocument[]): void {
    this.docs.set(sourceId, docs);
  }

  /** Flag a source (by id) to throw {@link ConnectorUnavailableError} on fetch (Req 23.9). */
  failConnector(sourceId: string, connector: ConnectorSourceType): void {
    this.unavailable.set(sourceId, connector);
  }

  async fetch(_ctx: TenantContext, source: KnowledgeSource): Promise<FetchedDocument[]> {
    this.calls.push(source.id);
    const connector = this.unavailable.get(source.id);
    if (connector !== undefined) {
      throw new ConnectorUnavailableError(connector, 'seeded unavailable in test');
    }
    return (this.docs.get(source.id) ?? []).map((doc) => ({ ...doc }));
  }
}

/**
 * A {@link SourceFetcherResolver} backed by a Map from source type to fetcher.
 *
 * Types left unregistered model an unconfigured source: a native type resolves
 * to `undefined` (a hard error in the service), an optional connector type
 * resolves to `undefined` (graceful degradation, Req 23.9).
 */
export class MapSourceFetcherResolver implements SourceFetcherResolver {
  private readonly byType = new Map<KnowledgeSourceType, SourceFetcher>();

  /** Register `fetcher` as the handler for `type`. */
  register(type: KnowledgeSourceType, fetcher: SourceFetcher): this {
    this.byType.set(type, fetcher);
    return this;
  }

  resolve(type: KnowledgeSourceType): SourceFetcher | undefined {
    return this.byType.get(type);
  }
}

/** Build a {@link FetchedDocument} from an external id plus optional overrides, for tests. */
export function makeFetchedDocument(
  externalId: string,
  overrides: Partial<FetchedDocument> = {},
): FetchedDocument {
  return {
    externalId,
    title: overrides.title ?? `Document ${externalId}`,
    content: overrides.content ?? `content of ${externalId}`,
    ...(overrides.location !== undefined ? { location: overrides.location } : {}),
    ...(overrides.link !== undefined ? { link: overrides.link } : {}),
  };
}

/**
 * A {@link ChunkAuthorizer} fake that authorizes every chunk for every
 * principal (Req 24.3).
 *
 * Useful for RAG_Retriever tests that focus on hybrid scoring, re-ranking,
 * top-K bounding, attribution completeness, and threshold signalling, where the
 * access filter should never remove a chunk. Records every chunk it was asked
 * about so a test can assert the filter ran.
 */
export class AllowAllChunkAuthorizer implements ChunkAuthorizer {
  /** Every chunk id passed to {@link authorize}, in order. */
  readonly calls: string[] = [];

  authorize(_principal: Principal, chunk: RetrievableChunk): boolean {
    this.calls.push(chunk.chunkId);
    return true;
  }
}

/**
 * A {@link ChunkAuthorizer} fake that authorizes a chunk only when its
 * {@link RetrievableChunk.sourceId} is in an explicit allow-list (Req 24.3).
 *
 * Models a collection/source whose retrieval is restricted to specific
 * teams/projects (Req 25.2): a chunk from a source the principal cannot access
 * is excluded from the retrieved context. The allow-list is keyed only by
 * source id here for deterministic tests; the production authorizer composes the
 * Knowledge_Manager access lists and Access_Control.
 */
export class SourceScopedChunkAuthorizer implements ChunkAuthorizer {
  private readonly allowed: Set<string>;

  constructor(allowedSourceIds: readonly string[]) {
    this.allowed = new Set(allowedSourceIds);
  }

  /** Add a source id to the allow-list. */
  allow(sourceId: string): this {
    this.allowed.add(sourceId);
    return this;
  }

  authorize(_principal: Principal, chunk: RetrievableChunk): boolean {
    return this.allowed.has(chunk.sourceId);
  }
}

/**
 * A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port, for
 * the Knowledge_Manager tests.
 */
export interface CapturedKnowledgeAudit {
  /** The tenant context the event was recorded under. */
  ctx: TenantContext;
  /** The recorded audit event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so
 * Knowledge_Manager tests can assert which mutations were audited (Req 37.1).
 *
 * Mirrors the capturing recorders used elsewhere in the codebase (e.g. the
 * Conversation_Manager) so the knowledge module's manager tests stay
 * self-contained.
 */
export class CapturingKnowledgeAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedKnowledgeAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `knowledge.collection.create`). */
  withAction(action: string): CapturedKnowledgeAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedKnowledgeAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/** A collection stored within its Organization, for the in-memory collection store. */
interface StoredCollectionEntry {
  /** The Organization the collection is scoped to. */
  organizationId: string;
  /** The persisted collection record. */
  record: KnowledgeCollection;
}

/**
 * An in-memory {@link KnowledgeCollectionStore} that scopes every record to the
 * {@link TenantContext} Organization (Req 1.2), for Knowledge_Manager tests.
 *
 * Models the observable behaviour of the tenant-scoped repositories closely
 * enough to exercise the manager: collections, sources, and documents are all
 * confined to their Organization; sources and documents are seeded directly
 * (the Knowledge_Ingestion_Service writes them in production); and the
 * duplicate/stale flag writes mutate the seeded document records.
 */
export class InMemoryKnowledgeCollectionStore implements KnowledgeCollectionStore {
  private readonly collections = new Map<string, StoredCollectionEntry>();
  private readonly sources = new Map<string, { organizationId: string; record: KnowledgeSource }>();
  private readonly documents = new Map<
    string,
    { organizationId: string; collectionId: string; record: KnowledgeDocumentRecord }
  >();

  /** Seed a collection (e.g. another tenant's, or with fixed timestamps). */
  seedCollection(organizationId: string, record: KnowledgeCollection): void {
    this.collections.set(record.id, { organizationId, record: { ...record } });
  }

  /** Seed a source belonging to a collection within an Organization. */
  seedSource(organizationId: string, record: KnowledgeSource): void {
    this.sources.set(record.id, { organizationId, record: { ...record } });
  }

  /**
   * Seed a document belonging to a collection within an Organization. The
   * document's source is associated with the collection so collection-wide
   * document/source listings resolve correctly.
   */
  seedDocument(
    organizationId: string,
    collectionId: string,
    record: KnowledgeDocumentRecord,
  ): void {
    this.documents.set(record.id, { organizationId, collectionId, record: { ...record } });
  }

  async createCollection(
    ctx: TenantContext,
    collection: KnowledgeCollection,
  ): Promise<KnowledgeCollection> {
    this.collections.set(collection.id, {
      organizationId: ctx.organizationId,
      record: { ...collection, allowedTeams: [...collection.allowedTeams], allowedProjects: [...collection.allowedProjects] },
    });
    return cloneCollection(collection);
  }

  async getCollection(
    ctx: TenantContext,
    collectionId: string,
  ): Promise<KnowledgeCollection | null> {
    const entry = this.collections.get(collectionId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return null;
    }
    return cloneCollection(entry.record);
  }

  async setCollectionAccess(
    ctx: TenantContext,
    collectionId: string,
    allowedTeams: string[],
    allowedProjects: string[],
  ): Promise<KnowledgeCollection | null> {
    const entry = this.collections.get(collectionId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return null;
    }
    entry.record.allowedTeams = [...allowedTeams];
    entry.record.allowedProjects = [...allowedProjects];
    return cloneCollection(entry.record);
  }

  async getCollectionForSource(
    ctx: TenantContext,
    sourceId: string,
  ): Promise<KnowledgeCollection | null> {
    const source = this.sources.get(sourceId);
    if (source === undefined || source.organizationId !== ctx.organizationId) {
      return null;
    }
    return this.getCollection(ctx, source.record.collectionId);
  }

  async listSourcesByCollection(
    ctx: TenantContext,
    collectionId: string,
  ): Promise<KnowledgeSource[]> {
    return [...this.sources.values()]
      .filter(
        (entry) =>
          entry.organizationId === ctx.organizationId &&
          entry.record.collectionId === collectionId,
      )
      .map((entry) => ({ ...entry.record }));
  }

  async listDocumentsByCollection(
    ctx: TenantContext,
    collectionId: string,
  ): Promise<KnowledgeDocumentRecord[]> {
    return [...this.documents.values()]
      .filter(
        (entry) =>
          entry.organizationId === ctx.organizationId && entry.collectionId === collectionId,
      )
      .map((entry) => ({ ...entry.record }));
  }

  async setDocumentDuplicate(
    ctx: TenantContext,
    documentId: string,
    duplicateOf: string,
  ): Promise<KnowledgeDocumentRecord | null> {
    const entry = this.documents.get(documentId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return null;
    }
    entry.record.duplicateOf = duplicateOf;
    return { ...entry.record };
  }

  async setDocumentStale(
    ctx: TenantContext,
    documentId: string,
    stale: boolean,
  ): Promise<KnowledgeDocumentRecord | null> {
    const entry = this.documents.get(documentId);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) {
      return null;
    }
    entry.record.stale = stale;
    return { ...entry.record };
  }
}

/** Deep-clone a collection so stored access lists can never be mutated by callers. */
function cloneCollection(record: KnowledgeCollection): KnowledgeCollection {
  return {
    ...record,
    allowedTeams: [...record.allowedTeams],
    allowedProjects: [...record.allowedProjects],
  };
}

/** Build a {@link KnowledgeSource} with sensible defaults; override field-by-field. */
export function makeKnowledgeSource(
  overrides: Partial<KnowledgeSource> = {},
): KnowledgeSource {
  return {
    id: 'src-1',
    collectionId: 'col-1',
    type: 'upload',
    syncMode: 'manual',
    syncStatus: 'idle',
    lastSyncAt: null,
    documentCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a {@link KnowledgeDocumentRecord} with sensible defaults; override field-by-field. */
export function makeKnowledgeDocumentRecord(
  overrides: Partial<KnowledgeDocumentRecord> = {},
): KnowledgeDocumentRecord {
  return {
    id: 'kdoc-1',
    sourceId: 'src-1',
    externalId: 'ext-1',
    title: 'Document',
    contentHash: '',
    stale: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a {@link KnowledgeCollection} with sensible defaults; override field-by-field. */
export function makeKnowledgeCollection(
  overrides: Partial<KnowledgeCollection> = {},
): KnowledgeCollection {
  return {
    id: 'col-1',
    organizationId: 'org-1',
    ownerScope: 'project',
    ownerScopeId: 'proj-1',
    name: 'Collection',
    allowedTeams: [],
    allowedProjects: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
