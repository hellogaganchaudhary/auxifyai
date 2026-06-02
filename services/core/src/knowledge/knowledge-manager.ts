/**
 * The Knowledge_Manager (Req 25.1-25.5).
 *
 * The administration side of the knowledge module: it organizes collections
 * over the sources the
 * {@link import('./knowledge-ingestion-service.js').KnowledgeIngestionService}
 * ingests into, and controls and reports on them. It composes two injected
 * ports so it is unit-testable without a database:
 *
 *   - a {@link KnowledgeCollectionStore} (satisfied by the tenant-scoped
 *     repository layer) — already tenant-scoped, so every operation is
 *     automatically confined to the caller's Organization (Req 1.2, 1.4); and
 *   - an {@link AuditRecorder} port (the concrete Audit_Service) — so *every
 *     mutation* (collection creation, access changes, duplicate flagging, stale
 *     marking) is recorded in the immutable audit trail (Req 37.1).
 *
 * Responsibilities mapped to acceptance criteria:
 *   - {@link KnowledgeManager.createCollection} — persists a collection with a
 *     name, owning Project/Team, and access list (Req 25.1), audited.
 *   - {@link KnowledgeManager.setAccess} — sets the Teams and Projects permitted
 *     to retrieve from a collection, restricting retrieval to their members
 *     (Req 25.2). The access lists are the model the RAG_Retriever's
 *     {@link import('./rag-types.js').ChunkAuthorizer} composes through
 *     {@link import('./knowledge-access.js').CollectionScopedChunkAuthorizer}.
 *   - {@link KnowledgeManager.sourceStatus} — reports each source's sync status,
 *     last sync time, and document count for the dashboard (Req 25.3).
 *   - {@link KnowledgeManager.flagDuplicates} — detects content duplicated within
 *     a collection (by shared content hash) and flags the later copies as
 *     duplicates of the earliest canonical document (Req 25.4), audited.
 *   - {@link KnowledgeManager.markStale} — marks every document not updated within
 *     the configured freshness window as stale (Req 25.5), audited; and
 *     {@link KnowledgeManager.listStaleDocuments} surfaces them for the
 *     dashboard.
 *
 * Every external capability is a narrow injectable port, so the manager is pure
 * orchestration and fully unit-testable with the in-memory fakes in
 * `./fakes.js`.
 */

import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@auxify/types';

import type { AuditRecorder } from '../audit/index.js';

import {
  InvalidCollectionInputError,
  UnknownCollectionError,
} from './manager-errors.js';
import {
  DEFAULT_FRESHNESS_WINDOW_MS,
  type CollectionIdGenerator,
  type CreateCollectionInput,
  type DuplicateFlag,
  type KnowledgeCollection,
  type KnowledgeCollectionStore,
  type KnowledgeManagerClock,
  type MarkStaleOptions,
  type SourceStatus,
  type StaleDocument,
} from './knowledge-manager-types.js';

/**
 * Construction-time dependencies for the {@link KnowledgeManager}.
 *
 * The {@link store} and {@link audit} ports are required; the id generator,
 * clock, and freshness window have defaults. Requiring the ports keeps the
 * manager honest — it never silently skips persistence or auditing — while
 * letting tests inject fakes.
 */
export interface KnowledgeManagerOptions {
  /** Tenant-scoped persistence for collections, sources, and documents (Req 25.1-25.5). */
  store: KnowledgeCollectionStore;
  /** The append-only audit sink; every mutation is recorded through it (Req 37.1). */
  audit: AuditRecorder;
  /** Id generator for new collections (defaults to `crypto.randomUUID`). */
  idGenerator?: CollectionIdGenerator;
  /** Clock for timestamps and staleness evaluation (defaults to `new Date()`). */
  clock?: KnowledgeManagerClock;
  /** The freshness window before a document is stale (defaults to {@link DEFAULT_FRESHNESS_WINDOW_MS}, Req 25.5). */
  freshnessWindowMs?: number;
}

/**
 * The concrete Knowledge_Manager. Construct it once with its ports, then call
 * its administration methods with the acting user's {@link TenantContext}.
 */
export class KnowledgeManager {
  private readonly store: KnowledgeCollectionStore;
  private readonly audit: AuditRecorder;
  private readonly newId: CollectionIdGenerator;
  private readonly now: KnowledgeManagerClock;
  private readonly freshnessWindowMs: number;

  constructor(options: KnowledgeManagerOptions) {
    this.store = options.store;
    this.audit = options.audit;
    this.newId = options.idGenerator ?? ((): string => randomUUID());
    this.now = options.clock ?? ((): Date => new Date());
    this.freshnessWindowMs = options.freshnessWindowMs ?? DEFAULT_FRESHNESS_WINDOW_MS;
  }

  /**
   * Create a collection, persisting its name, owning Team/Project, and access
   * list (Req 25.1). The creation is recorded in the Audit_Service.
   *
   * @throws {InvalidCollectionInputError} When the name or owner scope id is blank.
   */
  async createCollection(
    ctx: TenantContext,
    input: CreateCollectionInput,
  ): Promise<KnowledgeCollection> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new InvalidCollectionInputError('name', 'must not be blank');
    }
    if (input.ownerScopeId.trim().length === 0) {
      throw new InvalidCollectionInputError('ownerScopeId', 'must not be blank');
    }

    const collection: KnowledgeCollection = {
      id: input.id ?? this.newId(),
      organizationId: ctx.organizationId,
      ownerScope: input.ownerScope,
      ownerScopeId: input.ownerScopeId,
      name,
      allowedTeams: dedupe(input.allowedTeams ?? []),
      allowedProjects: dedupe(input.allowedProjects ?? []),
      createdAt: this.now().toISOString(),
    };

    const persisted = await this.store.createCollection(ctx, collection);
    await this.audit.record(ctx, {
      action: 'knowledge.collection.create',
      resourceType: 'knowledge_collection',
      resourceId: persisted.id,
      metadata: {
        ownerScope: persisted.ownerScope,
        ownerScopeId: persisted.ownerScopeId,
        allowedTeams: persisted.allowedTeams,
        allowedProjects: persisted.allowedProjects,
      },
    });
    return persisted;
  }

  /**
   * Set the Teams and Projects permitted to retrieve from a collection,
   * restricting retrieval to their members (Req 25.2). The change is recorded in
   * the Audit_Service.
   *
   * The persisted access lists are the model the RAG_Retriever's authorizer
   * composes ({@link import('./knowledge-access.js').CollectionScopedChunkAuthorizer}),
   * so updating them takes effect on subsequent retrievals.
   *
   * @throws {UnknownCollectionError} When no collection matches within the caller's Organization.
   */
  async setAccess(
    ctx: TenantContext,
    collectionId: string,
    teams: string[],
    projects: string[],
  ): Promise<KnowledgeCollection> {
    const allowedTeams = dedupe(teams);
    const allowedProjects = dedupe(projects);
    const updated = await this.store.setCollectionAccess(
      ctx,
      collectionId,
      allowedTeams,
      allowedProjects,
    );
    if (updated === null) {
      throw new UnknownCollectionError(collectionId);
    }
    await this.audit.record(ctx, {
      action: 'knowledge.collection.set_access',
      resourceType: 'knowledge_collection',
      resourceId: collectionId,
      metadata: { allowedTeams, allowedProjects },
    });
    return updated;
  }

  /**
   * Report each source's sync status, last sync time, and document count for a
   * collection's source-status dashboard (Req 25.3). Reads are not audited.
   *
   * @throws {UnknownCollectionError} When no collection matches within the caller's Organization.
   */
  async sourceStatus(ctx: TenantContext, collectionId: string): Promise<SourceStatus[]> {
    await this.requireCollection(ctx, collectionId);
    const sources = await this.store.listSourcesByCollection(ctx, collectionId);
    return sources.map((source) => ({
      sourceId: source.id,
      type: source.type,
      syncMode: source.syncMode,
      syncStatus: source.syncStatus,
      lastSyncAt: source.lastSyncAt,
      documentCount: source.documentCount,
    }));
  }

  /**
   * Detect content duplicated within a collection and flag the later copies as
   * duplicates of the earliest canonical document (Req 25.4). The flagging is
   * recorded in the Audit_Service.
   *
   * Documents sharing a non-empty content hash are duplicates of one another;
   * the earliest by creation time (ties broken by id) is treated as canonical
   * and every later copy is pointed at it. A document already flagged as the
   * same duplicate is left unchanged so the operation is idempotent.
   *
   * @throws {UnknownCollectionError} When no collection matches within the caller's Organization.
   */
  async flagDuplicates(ctx: TenantContext, collectionId: string): Promise<DuplicateFlag[]> {
    await this.requireCollection(ctx, collectionId);
    const documents = await this.store.listDocumentsByCollection(ctx, collectionId);

    // Group documents by content hash, ignoring blank hashes (never-indexed docs).
    const byHash = new Map<string, typeof documents>();
    for (const doc of documents) {
      if (doc.contentHash.trim().length === 0) {
        continue;
      }
      const group = byHash.get(doc.contentHash);
      if (group === undefined) {
        byHash.set(doc.contentHash, [doc]);
      } else {
        group.push(doc);
      }
    }

    const flags: DuplicateFlag[] = [];
    for (const [contentHash, group] of byHash) {
      if (group.length < 2) {
        continue;
      }
      // The earliest document (by creation time, then id) is canonical.
      const ordered = [...group].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
      const canonical = ordered[0];
      if (canonical === undefined) {
        continue;
      }
      for (const duplicate of ordered.slice(1)) {
        // Idempotent: skip a document already pointing at the canonical doc.
        if (duplicate.duplicateOf === canonical.id) {
          continue;
        }
        const updated = await this.store.setDocumentDuplicate(ctx, duplicate.id, canonical.id);
        if (updated === null) {
          continue;
        }
        flags.push({
          documentId: duplicate.id,
          duplicateOf: canonical.id,
          contentHash,
          sourceId: duplicate.sourceId,
        });
      }
    }

    if (flags.length > 0) {
      await this.audit.record(ctx, {
        action: 'knowledge.collection.flag_duplicates',
        resourceType: 'knowledge_collection',
        resourceId: collectionId,
        metadata: { flaggedCount: flags.length, documentIds: flags.map((f) => f.documentId) },
      });
    }
    return flags;
  }

  /**
   * Mark every document in a collection not updated within the configured
   * freshness window as stale (Req 25.5). The marking is recorded in the
   * Audit_Service and the newly-stale documents are returned.
   *
   * A document is stale when its `updatedAt` is older than `asOf -
   * freshnessWindowMs` (both the window and the evaluation instant are
   * overridable per call). A document already stale is left unchanged so the
   * operation is idempotent and only freshly-marked documents are returned.
   *
   * @throws {UnknownCollectionError} When no collection matches within the caller's Organization.
   */
  async markStale(
    ctx: TenantContext,
    collectionId: string,
    options: MarkStaleOptions = {},
  ): Promise<StaleDocument[]> {
    await this.requireCollection(ctx, collectionId);
    const documents = await this.store.listDocumentsByCollection(ctx, collectionId);

    const windowMs = options.freshnessWindowMs ?? this.freshnessWindowMs;
    const asOf = options.asOf ?? this.now();
    const cutoff = asOf.getTime() - windowMs;

    const marked: StaleDocument[] = [];
    for (const doc of documents) {
      if (doc.stale) {
        continue;
      }
      const updatedAtMs = Date.parse(doc.updatedAt);
      if (Number.isNaN(updatedAtMs) || updatedAtMs >= cutoff) {
        continue;
      }
      const updated = await this.store.setDocumentStale(ctx, doc.id, true);
      if (updated === null) {
        continue;
      }
      marked.push({
        documentId: doc.id,
        sourceId: doc.sourceId,
        title: doc.title,
        updatedAt: doc.updatedAt,
      });
    }

    if (marked.length > 0) {
      await this.audit.record(ctx, {
        action: 'knowledge.collection.mark_stale',
        resourceType: 'knowledge_collection',
        resourceId: collectionId,
        metadata: { staleCount: marked.length, documentIds: marked.map((d) => d.documentId) },
      });
    }
    return marked;
  }

  /**
   * List the documents currently flagged stale within a collection (Req 25.5),
   * for the dashboard. Reads are not audited.
   *
   * @throws {UnknownCollectionError} When no collection matches within the caller's Organization.
   */
  async listStaleDocuments(ctx: TenantContext, collectionId: string): Promise<StaleDocument[]> {
    await this.requireCollection(ctx, collectionId);
    const documents = await this.store.listDocumentsByCollection(ctx, collectionId);
    return documents
      .filter((doc) => doc.stale)
      .map((doc) => ({
        documentId: doc.id,
        sourceId: doc.sourceId,
        title: doc.title,
        updatedAt: doc.updatedAt,
      }));
  }

  /** Resolve a collection within the tenant scope or raise {@link UnknownCollectionError}. */
  private async requireCollection(
    ctx: TenantContext,
    collectionId: string,
  ): Promise<KnowledgeCollection> {
    const collection = await this.store.getCollection(ctx, collectionId);
    if (collection === null) {
      throw new UnknownCollectionError(collectionId);
    }
    return collection;
  }
}

/** Return the input array's distinct values, preserving first-occurrence order. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
