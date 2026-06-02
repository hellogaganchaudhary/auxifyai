/**
 * Unit tests for the Knowledge_Manager (Req 25.1-25.5).
 *
 * These exercise the full administration surface against the in-memory fakes —
 * no real database or Audit_Service:
 *
 *  - collection creation with a name, owning Team/Project, and access list,
 *    recorded in the audit trail (Req 25.1, 37.1), with input validation;
 *  - setting the Teams/Projects permitted to retrieve from a collection
 *    (Req 25.2), and the collection access predicate / production
 *    {@link CollectionScopedChunkAuthorizer} that restricts retrieval to their
 *    members (Req 25.2, 24.3);
 *  - reporting each source's sync status, last sync time, and document count for
 *    the dashboard (Req 25.3);
 *  - flagging content duplicated within a collection (Req 25.4);
 *  - marking documents outside the freshness window stale and surfacing them
 *    (Req 25.5);
 *  - tenant/access scoping — a principal cannot reach, mutate, or retrieve from
 *    another Organization's collection (Req 1.2, 1.4) — and the typed
 *    {@link UnknownCollectionError} / {@link InvalidCollectionInputError}.
 */

import { describe, expect, it } from 'vitest';

import type { Principal, SourceAttribution, TenantContext } from '@auxify/types';

import {
  CapturingKnowledgeAuditRecorder,
  InMemoryKnowledgeCollectionStore,
  makeKnowledgeCollection,
  makeKnowledgeDocumentRecord,
  makeKnowledgeSource,
} from './fakes.js';
import { KnowledgeManager } from './knowledge-manager.js';
import {
  CollectionScopedChunkAuthorizer,
  principalCanAccessCollection,
} from './knowledge-access.js';
import {
  INVALID_COLLECTION_INPUT_CODE,
  InvalidCollectionInputError,
  UNKNOWN_COLLECTION_CODE,
  UnknownCollectionError,
} from './manager-errors.js';
import type { RetrievableChunk } from './rag-types.js';

const ORG = 'org-1';
const OTHER_ORG = 'org-2';

const ctx: TenantContext = { organizationId: ORG, userId: 'admin-1' };
const otherCtx: TenantContext = { organizationId: OTHER_ORG, userId: 'admin-2' };

interface Harness {
  manager: KnowledgeManager;
  store: InMemoryKnowledgeCollectionStore;
  audit: CapturingKnowledgeAuditRecorder;
}

/** A deterministic clock fixed at a known instant, for staleness evaluation. */
const FIXED_NOW = new Date('2026-06-01T00:00:00.000Z');

/** Build a manager wired to fresh fakes with deterministic ids and clock. */
function makeManager(overrides: Partial<{ freshnessWindowMs: number }> = {}): Harness {
  const store = new InMemoryKnowledgeCollectionStore();
  const audit = new CapturingKnowledgeAuditRecorder();
  let n = 0;
  const manager = new KnowledgeManager({
    store,
    audit,
    idGenerator: () => {
      n += 1;
      return `col-${n}`;
    },
    clock: () => FIXED_NOW,
    ...overrides,
  });
  return { manager, store, audit };
}

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

/** A complete attribution, for building retrievable chunks. */
function attribution(sourceId: string): SourceAttribution {
  return {
    sourceId,
    sourceTitle: `Source ${sourceId}`,
    location: 'section-1',
    link: `https://example.test/${sourceId}`,
  };
}

/** Build a retrievable chunk owned by a source, for authorizer tests. */
function makeChunk(sourceId: string, overrides: Partial<RetrievableChunk> = {}): RetrievableChunk {
  return {
    chunkId: `chunk-${sourceId}`,
    organizationId: ORG,
    sourceId,
    documentId: `doc-${sourceId}`,
    ordinal: 0,
    text: 'some retrievable text',
    attribution: attribution(sourceId),
    ...overrides,
  };
}

describe('KnowledgeManager.createCollection (Req 25.1)', () => {
  it('persists name, owning scope, and access lists, and audits the creation', async () => {
    const { manager, store, audit } = makeManager();

    const collection = await manager.createCollection(ctx, {
      name: 'Eng Wiki',
      ownerScope: 'team',
      ownerScopeId: 'team-7',
      allowedTeams: ['team-7', 'team-8'],
      allowedProjects: ['proj-1'],
    });

    expect(collection).toMatchObject({
      id: 'col-1',
      organizationId: ORG,
      ownerScope: 'team',
      ownerScopeId: 'team-7',
      name: 'Eng Wiki',
      allowedTeams: ['team-7', 'team-8'],
      allowedProjects: ['proj-1'],
    });
    expect(collection.createdAt).toBe(FIXED_NOW.toISOString());

    // It is durably persisted under the Organization.
    const reloaded = await store.getCollection(ctx, collection.id);
    expect(reloaded).toMatchObject({ id: 'col-1', name: 'Eng Wiki' });

    // The creation is audited (Req 37.1) with the access list in the metadata.
    const events = audit.withAction('knowledge.collection.create');
    expect(events).toHaveLength(1);
    expect(events[0]?.event.resourceType).toBe('knowledge_collection');
    expect(events[0]?.event.resourceId).toBe('col-1');
    expect(events[0]?.event.metadata).toMatchObject({
      allowedTeams: ['team-7', 'team-8'],
      allowedProjects: ['proj-1'],
    });
    expect(events[0]?.ctx.organizationId).toBe(ORG);
  });

  it('defaults the access lists to empty and trims the name', async () => {
    const { manager } = makeManager();

    const collection = await manager.createCollection(ctx, {
      name: '  Trimmed  ',
      ownerScope: 'project',
      ownerScopeId: 'proj-9',
    });

    expect(collection.name).toBe('Trimmed');
    expect(collection.allowedTeams).toEqual([]);
    expect(collection.allowedProjects).toEqual([]);
  });

  it('deduplicates the supplied access lists', async () => {
    const { manager } = makeManager();

    const collection = await manager.createCollection(ctx, {
      name: 'Dupes',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
      allowedTeams: ['team-1', 'team-1', 'team-2'],
      allowedProjects: ['proj-1', 'proj-1'],
    });

    expect(collection.allowedTeams).toEqual(['team-1', 'team-2']);
    expect(collection.allowedProjects).toEqual(['proj-1']);
  });

  it('honors an explicit id when provided', async () => {
    const { manager } = makeManager();

    const collection = await manager.createCollection(ctx, {
      id: 'explicit-col',
      name: 'Explicit',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
    });

    expect(collection.id).toBe('explicit-col');
  });

  it('rejects a blank name with InvalidCollectionInputError and audits nothing', async () => {
    const { manager, audit } = makeManager();

    await expect(
      manager.createCollection(ctx, { name: '   ', ownerScope: 'team', ownerScopeId: 'team-1' }),
    ).rejects.toBeInstanceOf(InvalidCollectionInputError);
    expect(audit.count).toBe(0);
  });

  it('rejects a blank owner scope id with InvalidCollectionInputError', async () => {
    const { manager } = makeManager();

    await expect(
      manager.createCollection(ctx, { name: 'Valid', ownerScope: 'project', ownerScopeId: '  ' }),
    ).rejects.toMatchObject({
      name: 'InvalidCollectionInputError',
      field: 'ownerScopeId',
    });
  });
});

describe('KnowledgeManager.setAccess (Req 25.2)', () => {
  it('replaces the access lists, dedupes, and audits the change', async () => {
    const { manager, store, audit } = makeManager();
    const created = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
    });

    const updated = await manager.setAccess(
      ctx,
      created.id,
      ['team-2', 'team-2', 'team-3'],
      ['proj-5'],
    );

    expect(updated.allowedTeams).toEqual(['team-2', 'team-3']);
    expect(updated.allowedProjects).toEqual(['proj-5']);

    const reloaded = await store.getCollection(ctx, created.id);
    expect(reloaded?.allowedTeams).toEqual(['team-2', 'team-3']);

    const events = audit.withAction('knowledge.collection.set_access');
    expect(events).toHaveLength(1);
    expect(events[0]?.event.metadata).toMatchObject({
      allowedTeams: ['team-2', 'team-3'],
      allowedProjects: ['proj-5'],
    });
  });

  it('throws UnknownCollectionError for an unknown collection and audits nothing', async () => {
    const { manager, audit } = makeManager();

    await expect(manager.setAccess(ctx, 'missing', ['team-1'], [])).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
    expect(audit.withAction('knowledge.collection.set_access')).toHaveLength(0);
  });
});

describe('KnowledgeManager.sourceStatus (Req 25.3)', () => {
  it("reports each source's sync status, last sync time, and document count", async () => {
    const { manager, store } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });

    store.seedSource(
      ORG,
      makeKnowledgeSource({
        id: 'src-a',
        collectionId: collection.id,
        type: 'github',
        syncMode: 'scheduled',
        syncStatus: 'synced',
        lastSyncAt: '2026-05-30T10:00:00.000Z',
        documentCount: 12,
      }),
    );
    store.seedSource(
      ORG,
      makeKnowledgeSource({
        id: 'src-b',
        collectionId: collection.id,
        type: 'web_url',
        syncMode: 'manual',
        syncStatus: 'idle',
        lastSyncAt: null,
        documentCount: 0,
      }),
    );

    const statuses = await manager.sourceStatus(ctx, collection.id);

    expect(statuses).toHaveLength(2);
    const byId = new Map(statuses.map((s) => [s.sourceId, s]));
    expect(byId.get('src-a')).toEqual({
      sourceId: 'src-a',
      type: 'github',
      syncMode: 'scheduled',
      syncStatus: 'synced',
      lastSyncAt: '2026-05-30T10:00:00.000Z',
      documentCount: 12,
    });
    expect(byId.get('src-b')).toMatchObject({
      syncStatus: 'idle',
      lastSyncAt: null,
      documentCount: 0,
    });
  });

  it('does not audit a status read', async () => {
    const { manager, audit } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });
    audit.recorded.length = 0;

    await manager.sourceStatus(ctx, collection.id);

    expect(audit.count).toBe(0);
  });

  it('throws UnknownCollectionError for an unknown collection', async () => {
    const { manager } = makeManager();
    await expect(manager.sourceStatus(ctx, 'missing')).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
  });
});

describe('KnowledgeManager.flagDuplicates (Req 25.4)', () => {
  it('flags later copies of duplicate content as duplicates of the earliest canonical doc', async () => {
    const { manager, store, audit } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
    });
    store.seedSource(ORG, makeKnowledgeSource({ id: 'src-1', collectionId: collection.id }));

    // Three documents share a content hash; the earliest by createdAt is canonical.
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'doc-early',
        sourceId: 'src-1',
        contentHash: 'hash-x',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'doc-mid',
        sourceId: 'src-1',
        contentHash: 'hash-x',
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'doc-late',
        sourceId: 'src-1',
        contentHash: 'hash-x',
        createdAt: '2026-03-01T00:00:00.000Z',
      }),
    );
    // A distinct hash is never flagged.
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'doc-unique', sourceId: 'src-1', contentHash: 'hash-y' }),
    );

    const flags = await manager.flagDuplicates(ctx, collection.id);

    expect(flags).toHaveLength(2);
    for (const flag of flags) {
      expect(flag.duplicateOf).toBe('doc-early');
      expect(flag.contentHash).toBe('hash-x');
    }
    expect(flags.map((f) => f.documentId).sort()).toEqual(['doc-late', 'doc-mid']);

    // The canonical and unique docs are left unflagged in the store.
    const docs = await store.listDocumentsByCollection(ctx, collection.id);
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get('doc-early')?.duplicateOf).toBeUndefined();
    expect(byId.get('doc-unique')?.duplicateOf).toBeUndefined();
    expect(byId.get('doc-mid')?.duplicateOf).toBe('doc-early');
    expect(byId.get('doc-late')?.duplicateOf).toBe('doc-early');

    expect(audit.withAction('knowledge.collection.flag_duplicates')).toHaveLength(1);
  });

  it('ignores documents with a blank content hash', async () => {
    const { manager, store } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
    });
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'd1', contentHash: '' }),
    );
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'd2', contentHash: '' }),
    );

    const flags = await manager.flagDuplicates(ctx, collection.id);
    expect(flags).toEqual([]);
  });

  it('is idempotent — a second pass flags nothing new and records no further audit', async () => {
    const { manager, store, audit } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
    });
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'doc-a',
        contentHash: 'h',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'doc-b',
        contentHash: 'h',
        createdAt: '2026-02-01T00:00:00.000Z',
      }),
    );

    const first = await manager.flagDuplicates(ctx, collection.id);
    expect(first).toHaveLength(1);
    const auditAfterFirst = audit.withAction('knowledge.collection.flag_duplicates').length;

    const second = await manager.flagDuplicates(ctx, collection.id);
    expect(second).toEqual([]);
    expect(audit.withAction('knowledge.collection.flag_duplicates')).toHaveLength(auditAfterFirst);
  });

  it('throws UnknownCollectionError for an unknown collection', async () => {
    const { manager } = makeManager();
    await expect(manager.flagDuplicates(ctx, 'missing')).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
  });
});

describe('KnowledgeManager.markStale / listStaleDocuments (Req 25.5)', () => {
  it('marks documents older than the freshness window stale and leaves fresh ones', async () => {
    // 30-day window evaluated against FIXED_NOW (2026-06-01).
    const windowMs = 30 * 24 * 60 * 60 * 1000;
    const { manager, store, audit } = makeManager({ freshnessWindowMs: windowMs });
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });

    // Updated 60 days ago → stale.
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'old',
        title: 'Old',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
    );
    // Updated 1 day ago → fresh.
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({
        id: 'fresh',
        title: 'Fresh',
        updatedAt: '2026-05-31T00:00:00.000Z',
      }),
    );

    const marked = await manager.markStale(ctx, collection.id);

    expect(marked.map((d) => d.documentId)).toEqual(['old']);
    expect(marked[0]).toMatchObject({ documentId: 'old', title: 'Old' });

    const docs = await store.listDocumentsByCollection(ctx, collection.id);
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get('old')?.stale).toBe(true);
    expect(byId.get('fresh')?.stale).toBe(false);

    expect(audit.withAction('knowledge.collection.mark_stale')).toHaveLength(1);
  });

  it('honors a per-call freshness window and evaluation instant', async () => {
    const { manager, store } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'doc', updatedAt: '2026-05-20T00:00:00.000Z' }),
    );

    // A 1-day window as of 2026-05-25 → the 2026-05-20 doc is stale.
    const marked = await manager.markStale(ctx, collection.id, {
      freshnessWindowMs: 24 * 60 * 60 * 1000,
      asOf: new Date('2026-05-25T00:00:00.000Z'),
    });
    expect(marked.map((d) => d.documentId)).toEqual(['doc']);
  });

  it('is idempotent — already-stale documents are not re-marked or re-audited', async () => {
    const { manager, store, audit } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'doc', updatedAt: '2026-01-01T00:00:00.000Z' }),
    );

    const first = await manager.markStale(ctx, collection.id);
    expect(first).toHaveLength(1);
    const auditAfterFirst = audit.withAction('knowledge.collection.mark_stale').length;

    const second = await manager.markStale(ctx, collection.id);
    expect(second).toEqual([]);
    expect(audit.withAction('knowledge.collection.mark_stale')).toHaveLength(auditAfterFirst);
  });

  it('surfaces every stale document via listStaleDocuments without auditing', async () => {
    const { manager, store, audit } = makeManager();
    const collection = await manager.createCollection(ctx, {
      name: 'Col',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'stale-1', stale: true, title: 'S1' }),
    );
    store.seedDocument(
      ORG,
      collection.id,
      makeKnowledgeDocumentRecord({ id: 'fresh-1', stale: false, title: 'F1' }),
    );
    audit.recorded.length = 0;

    const stale = await manager.listStaleDocuments(ctx, collection.id);

    expect(stale.map((d) => d.documentId)).toEqual(['stale-1']);
    expect(stale[0]?.title).toBe('S1');
    expect(audit.count).toBe(0);
  });

  it('throws UnknownCollectionError for an unknown collection', async () => {
    const { manager } = makeManager();
    await expect(manager.markStale(ctx, 'missing')).rejects.toBeInstanceOf(UnknownCollectionError);
    await expect(manager.listStaleDocuments(ctx, 'missing')).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
  });
});

describe('Knowledge_Manager tenant scoping (Req 1.2, 1.4)', () => {
  it("cannot read or mutate another Organization's collection", async () => {
    const { manager, store } = makeManager();
    // A collection that belongs to a different Organization.
    store.seedCollection(
      OTHER_ORG,
      makeKnowledgeCollection({ id: 'foreign', organizationId: OTHER_ORG }),
    );

    // Every manager operation treats the cross-tenant collection as absent.
    await expect(manager.setAccess(ctx, 'foreign', ['team-1'], [])).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
    await expect(manager.sourceStatus(ctx, 'foreign')).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
    await expect(manager.flagDuplicates(ctx, 'foreign')).rejects.toBeInstanceOf(
      UnknownCollectionError,
    );
    await expect(manager.markStale(ctx, 'foreign')).rejects.toBeInstanceOf(UnknownCollectionError);

    // But its true owner can reach it.
    const status = await manager.sourceStatus(otherCtx, 'foreign');
    expect(status).toEqual([]);
  });

  it('scopes a created collection to its Organization', async () => {
    const { manager, store } = makeManager();
    const created = await manager.createCollection(ctx, {
      name: 'Private',
      ownerScope: 'team',
      ownerScopeId: 'team-1',
    });

    expect(await store.getCollection(ctx, created.id)).not.toBeNull();
    expect(await store.getCollection(otherCtx, created.id)).toBeNull();
  });
});

describe('principalCanAccessCollection (Req 25.2, 1.2)', () => {
  const collection = makeKnowledgeCollection({
    id: 'col-1',
    organizationId: ORG,
    ownerScope: 'team',
    ownerScopeId: 'owner-team',
    allowedTeams: ['team-a'],
    allowedProjects: ['proj-a'],
  });

  it('grants a member of a permitted team', () => {
    expect(principalCanAccessCollection(makePrincipal({ teamIds: ['team-a'] }), collection)).toBe(
      true,
    );
  });

  it('grants a member of a permitted project', () => {
    expect(
      principalCanAccessCollection(makePrincipal({ projectIds: ['proj-a'] }), collection),
    ).toBe(true);
  });

  it('grants the owning team even with the principal outside the access lists', () => {
    expect(
      principalCanAccessCollection(makePrincipal({ teamIds: ['owner-team'] }), collection),
    ).toBe(true);
  });

  it('denies a same-org principal in no permitted or owning team/project', () => {
    expect(
      principalCanAccessCollection(
        makePrincipal({ teamIds: ['team-z'], projectIds: ['proj-z'] }),
        collection,
      ),
    ).toBe(false);
  });

  it('denies a principal from another Organization regardless of membership', () => {
    expect(
      principalCanAccessCollection(
        makePrincipal({ organizationId: OTHER_ORG, teamIds: ['team-a'] }),
        collection,
      ),
    ).toBe(false);
  });
});

describe('CollectionScopedChunkAuthorizer (Req 24.3, 25.2)', () => {
  it('authorizes a chunk only when the principal can access its owning collection', async () => {
    const store = new InMemoryKnowledgeCollectionStore();
    store.seedCollection(
      ORG,
      makeKnowledgeCollection({
        id: 'restricted',
        organizationId: ORG,
        ownerScope: 'team',
        ownerScopeId: 'owner-team',
        allowedTeams: ['team-a'],
      }),
    );
    store.seedSource(
      ORG,
      makeKnowledgeSource({ id: 'src-restricted', collectionId: 'restricted' }),
    );
    const authorizer = new CollectionScopedChunkAuthorizer(store);
    const chunk = makeChunk('src-restricted');

    // A member of the permitted team is allowed.
    await expect(
      authorizer.authorize(makePrincipal({ teamIds: ['team-a'] }), chunk),
    ).resolves.toBe(true);
  });

  it('excludes a chunk from a collection the principal cannot access', async () => {
    const store = new InMemoryKnowledgeCollectionStore();
    store.seedCollection(
      ORG,
      makeKnowledgeCollection({
        id: 'restricted',
        organizationId: ORG,
        ownerScope: 'team',
        ownerScopeId: 'owner-team',
        allowedTeams: ['team-a'],
      }),
    );
    store.seedSource(
      ORG,
      makeKnowledgeSource({ id: 'src-restricted', collectionId: 'restricted' }),
    );
    const authorizer = new CollectionScopedChunkAuthorizer(store);

    await expect(
      authorizer.authorize(makePrincipal({ teamIds: ['team-z'] }), makeChunk('src-restricted')),
    ).resolves.toBe(false);
  });

  it('fails closed when the chunk source cannot be resolved to a collection', async () => {
    const store = new InMemoryKnowledgeCollectionStore();
    const authorizer = new CollectionScopedChunkAuthorizer(store);

    await expect(
      authorizer.authorize(makePrincipal({ teamIds: ['team-a'] }), makeChunk('orphan-source')),
    ).resolves.toBe(false);
  });

  it("fails closed for a chunk from another Organization's source", async () => {
    const store = new InMemoryKnowledgeCollectionStore();
    store.seedCollection(
      OTHER_ORG,
      makeKnowledgeCollection({ id: 'foreign', organizationId: OTHER_ORG, allowedTeams: ['team-a'] }),
    );
    store.seedSource(OTHER_ORG, makeKnowledgeSource({ id: 'src-foreign', collectionId: 'foreign' }));
    const authorizer = new CollectionScopedChunkAuthorizer(store);

    // The principal is in org-1; the source/collection live in org-2.
    await expect(
      authorizer.authorize(makePrincipal({ teamIds: ['team-a'] }), makeChunk('src-foreign')),
    ).resolves.toBe(false);
  });
});

describe('Knowledge_Manager typed errors (Req 46.8)', () => {
  it('projects UnknownCollectionError into a not_found platform error', () => {
    const err = new UnknownCollectionError('col-x');
    const platform = err.toPlatformError('corr-1');
    expect(platform).toMatchObject({
      category: 'not_found',
      code: UNKNOWN_COLLECTION_CODE,
      correlationId: 'corr-1',
      details: { collectionId: 'col-x' },
    });
  });

  it('projects InvalidCollectionInputError into a validation platform error', () => {
    const err = new InvalidCollectionInputError('name', 'must not be blank');
    const platform = err.toPlatformError('corr-2');
    expect(platform).toMatchObject({
      category: 'validation',
      code: INVALID_COLLECTION_INPUT_CODE,
      correlationId: 'corr-2',
      details: { field: 'name' },
    });
  });
});
