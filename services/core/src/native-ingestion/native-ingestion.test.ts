/**
 * Unit tests for the native-module ingestion + unified-search wiring
 * (Req 26.8, 27.9, 28.5, 29.1, 29.2).
 *
 * These assemble the REAL native module services — a Knowledge_Hub_Service, a
 * Messaging_Service, and a Document_Management_Service — each wired with the
 * {@link NativeIngestionBridge}'s emitter adapter over a REAL
 * {@link KnowledgeIngestionService} (built by {@link createNativeIngestionBridge}
 * with the component modules' in-memory stores, the File_Processor's
 * deterministic embedder, and the shared in-memory Vector_Store / Object_Store),
 * then assert the end-to-end wiring contract:
 *
 *   (a) creating a page / posting a message / uploading a document each results
 *       in the content being INDEXED as a `knowledge_chunk` record and RETRIEVABLE
 *       — both directly through the Knowledge_Ingestion_Service's Vector_Store
 *       index and through a unified search (Req 26.8, 27.9, 28.5);
 *   (b) a UnifiedSearchService built from the wiring returns authorized content
 *       created in EACH module for a matching query, grouped by content type
 *       (Req 29.1);
 *   (c) an ingestion failure on write does NOT fail the originating module write
 *       — the failure is recorded, never thrown back (Req 23.8 resilience);
 *   (d) unauthorized content is excluded from unified search results
 *       (Req 29.2 defense-in-depth).
 *
 * The component-module fakes are imported directly from each module's
 * `./fakes.js` (per the established convention) and the wiring's own
 * capturing-failure-recorder fake from `./fakes.js`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Principal, TenantContext } from '@auxify/types';

import { DocumentManagementService } from '../document-management/index.js';
import * as dmsFakes from '../document-management/fakes.js';
import { KnowledgeHubService } from '../knowledge-hub/index.js';
import * as khFakes from '../knowledge-hub/fakes.js';
import { MessagingService } from '../messaging/index.js';
import * as msgFakes from '../messaging/fakes.js';
import { EMBEDDING_DIMENSIONS } from '../storage/index.js';
import type { UnifiedSearchAuthorizer } from '../unified-search/index.js';

import {
  CapturingIngestionFailureRecorder,
  DeterministicEmbedder,
  InMemoryKnowledgeStore,
  InMemoryObjectStore,
  InMemoryVectorStore,
} from './fakes.js';
import {
  NativeIngestionBridge,
  ObjectStoreDocumentContentReader,
  createNativeIngestionBridge,
  createUnifiedSearchService,
  type NativeSourceResolver,
} from './index.js';

const ORG = 'org-1';
const PROJECT = 'proj-1';
const CHANNEL = 'chan-1';

/** A probe vector; the in-memory Vector_Store returns every org-scoped record regardless of score. */
const PROBE = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

/** A `k` larger than any test population so a query returns every matching record. */
const ALL = 100_000;

/** The acting principal in {@link ORG}. */
const principal: Principal = {
  userId: 'user-1',
  organizationId: ORG,
  roles: ['standard_user'],
  teamIds: [],
  projectIds: [PROJECT],
  allowedModels: [],
  premiumAuthorized: false,
};

/** The messaging tenant context for the acting principal. */
const ctx: TenantContext = { organizationId: ORG, userId: 'user-1' };

/** A fully-wired native-ingestion harness: three real module services over one bridge. */
function makeHarness() {
  const knowledgeStore = new InMemoryKnowledgeStore();
  const embedder = new DeterministicEmbedder();
  const vectors = new InMemoryVectorStore();
  const objects = new InMemoryObjectStore();

  // The bridge + the real Knowledge_Ingestion_Service it forwards to (one unit).
  const wiring = createNativeIngestionBridge({
    store: knowledgeStore,
    embedder,
    vectorStore: vectors,
    objectStore: objects,
    collectionId: 'col-native',
  });

  // Knowledge_Hub_Service wired with the bridge's page emitter adapter (Req 26.8).
  const pageStore = new khFakes.InMemoryPageStore(khFakes.monotonicClock());
  const knowledgeHub = new KnowledgeHubService({
    pages: pageStore,
    audit: new khFakes.CapturingAuditRecorder(),
    ingestion: wiring.bridge.pages,
    notifier: new khFakes.CapturingPageNotifier(),
    authorizer: new khFakes.AllowAllPageAuthorizer(),
    idGenerator: khFakes.sequentialPageIdGenerator(),
  });

  // Messaging_Service wired with the bridge's message emitter adapter (Req 27.9).
  const channels = new msgFakes.InMemoryChannelStore();
  const orgByChannel = new Map<string, string>();
  const messageStore = new msgFakes.InMemoryChannelMessageStore((id) => orgByChannel.get(id));
  const messaging = new MessagingService({
    channels,
    messages: messageStore,
    audit: new msgFakes.CapturingMessagingAuditRecorder(),
    ingestion: wiring.bridge.messages,
    idGenerator: msgFakes.sequentialMessagingIdGenerator(),
  });
  const channel = msgFakes.makeChannel({
    id: CHANNEL,
    organizationId: ORG,
    members: ['user-1'],
    visibility: 'public',
  });
  channels.seed(ORG, channel);
  orgByChannel.set(CHANNEL, ORG);

  // Document_Management_Service wired with the bridge's document emitter adapter
  // (Req 28.5). Shares the SAME Object_Store the bridge's content reader reads.
  const docStore = new dmsFakes.InMemoryDocumentStore(dmsFakes.monotonicClock());
  const documents = new DocumentManagementService({
    documents: docStore,
    objectStore: objects,
    audit: new dmsFakes.CapturingAuditRecorder(),
    ingestion: wiring.bridge.documents,
    backup: new dmsFakes.InMemoryDocumentBackupStore(),
    compliance: new dmsFakes.RecordingComplianceManager(),
    authorizer: new dmsFakes.AllowAllDocAuthorizer(),
    idGenerator: dmsFakes.sequentialDocumentIdGenerator(),
  });

  return {
    wiring,
    embedder,
    vectors,
    objects,
    knowledgeHub,
    messaging,
    channels,
    orgByChannel,
    documents,
  };
}

/** Build a unified-search service over the harness's shared `knowledge_chunk` index. */
function searchOver(h: ReturnType<typeof makeHarness>, authorizer?: UnifiedSearchAuthorizer) {
  return createUnifiedSearchService({
    embedder: h.embedder,
    vectorStore: h.vectors,
    ...(authorizer !== undefined ? { authorizer } : {}),
  });
}

/** All indexed `knowledge_chunk` records in {@link ORG}, via a Vector_Store probe query. */
async function indexedChunks(h: ReturnType<typeof makeHarness>) {
  return h.vectors.query(PROBE, { organizationId: ORG, ownerType: 'knowledge_chunk' }, ALL);
}

describe('Native ingestion-on-write indexes content as retrievable knowledge_chunk records', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it('(a) creating a page indexes it and makes it retrievable (Req 26.8)', async () => {
    const page = await h.knowledgeHub.createPage(principal, {
      projectId: PROJECT,
      title: 'Quarterly Plan',
      content: khFakes.makeRichContent('quarterly planning roadmap for the platform team'),
    });

    // Indexed: a knowledge_chunk record now exists carrying the page's content + attribution.
    const chunks = await indexedChunks(h);
    expect(chunks.length).toBeGreaterThan(0);
    const pageChunk = chunks.find(
      (c) => (c.metadata['attribution'] as { link?: string }).link?.includes(page.id) ?? false,
    );
    expect(pageChunk).toBeDefined();
    expect(String(pageChunk?.metadata['text'])).toContain('quarterly');

    // Retrievable: unified search surfaces it under the knowledge_page group.
    const result = await searchOver(h).search('quarterly', principal);
    const pageGroup = result.groups.find((g) => g.type === 'knowledge_page');
    expect(pageGroup).toBeDefined();
    expect(pageGroup?.items.some((i) => i.title === 'Quarterly Plan')).toBe(true);
  });

  it('(a) posting a message indexes it and makes it retrievable (Req 27.9)', async () => {
    const before = (await indexedChunks(h)).length;

    const message = await h.messaging.post(ctx, CHANNEL, {
      body: 'quarterly planning sync notes and action items',
    });

    const after = await indexedChunks(h);
    expect(after.length).toBe(before + 1);
    const msgChunk = after.find((c) =>
      String((c.metadata['attribution'] as { link?: string }).link ?? '').includes(message.id),
    );
    expect(msgChunk).toBeDefined();

    const result = await searchOver(h).search('quarterly', principal);
    const messageGroup = result.groups.find((g) => g.type === 'message');
    expect(messageGroup).toBeDefined();
    expect(messageGroup?.items.length).toBeGreaterThan(0);
  });

  it('(a) uploading a document indexes it and makes it retrievable (Req 28.5)', async () => {
    const doc = await h.documents.upload(principal, {
      projectId: PROJECT,
      name: 'plan.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('quarterly planning report contents for review'),
    });

    const chunks = await indexedChunks(h);
    const docChunk = chunks.find((c) =>
      String((c.metadata['attribution'] as { link?: string }).link ?? '').includes(doc.id),
    );
    expect(docChunk).toBeDefined();
    expect(String(docChunk?.metadata['text'])).toContain('quarterly');

    const result = await searchOver(h).search('quarterly', principal);
    const documentGroup = result.groups.find((g) => g.type === 'document');
    expect(documentGroup).toBeDefined();
    expect(documentGroup?.items.some((i) => i.title === 'plan.txt')).toBe(true);
  });
});

describe('Unified search across all native sources (Req 29.1)', () => {
  it('(b) returns authorized content from every module for a matching query, grouped by type', async () => {
    const h = makeHarness();

    await h.knowledgeHub.createPage(principal, {
      projectId: PROJECT,
      title: 'Quarterly Plan',
      content: khFakes.makeRichContent('quarterly planning roadmap and goals'),
    });
    await h.messaging.post(ctx, CHANNEL, { body: 'quarterly planning kickoff thread' });
    await h.documents.upload(principal, {
      projectId: PROJECT,
      name: 'quarterly-report.txt',
      contentType: 'text/plain',
      bytes: new TextEncoder().encode('quarterly planning financial report'),
    });

    const result = await searchOver(h).search('quarterly', principal);

    const types = new Set(result.groups.map((g) => g.type));
    expect(types.has('knowledge_page')).toBe(true);
    expect(types.has('message')).toBe(true);
    expect(types.has('document')).toBe(true);

    // Every surfaced item is internally ranked with a finite hybrid score and a
    // location pointing back to its owning module (Req 29.5, 29.6).
    for (const group of result.groups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.score).toBeGreaterThanOrEqual(0);
        expect(item.score).toBeLessThanOrEqual(1);
        expect(item.location.resourceType).toBe(group.type);
      }
    }
  });

  it('(b) confines results to the requesting principal\'s Organization (Req 1.2)', async () => {
    const h = makeHarness();
    await h.knowledgeHub.createPage(principal, {
      projectId: PROJECT,
      title: 'Quarterly Plan',
      content: khFakes.makeRichContent('quarterly planning roadmap'),
    });

    // A principal in a different Organization sees none of org-1's indexed content.
    const foreign: Principal = { ...principal, organizationId: 'org-2', userId: 'user-9' };
    const result = await searchOver(h).search('quarterly', foreign);
    expect(result.groups).toHaveLength(0);
  });
});

describe('Ingestion-on-write resilience (Req 23.8)', () => {
  it('(c) an indexing failure does not break the originating module write', async () => {
    const h = makeHarness();
    const recorder = new CapturingIngestionFailureRecorder();

    // A bridge whose source resolution always fails — every forward must record
    // the failure and swallow it, never throwing back to the writer.
    const failingResolver: NativeSourceResolver = {
      resolveSourceId: () => Promise.reject(new Error('knowledge index unavailable')),
    };
    const failingBridge = new NativeIngestionBridge({
      ingestion: h.wiring.ingestion,
      sources: failingResolver,
      staging: h.wiring.staging,
      documentContent: new ObjectStoreDocumentContentReader(h.objects),
      failureRecorder: recorder,
    });

    const channels = new msgFakes.InMemoryChannelStore();
    const orgByChannel = new Map<string, string>();
    const messageStore = new msgFakes.InMemoryChannelMessageStore((id) => orgByChannel.get(id));
    const messaging = new MessagingService({
      channels,
      messages: messageStore,
      audit: new msgFakes.CapturingMessagingAuditRecorder(),
      ingestion: failingBridge.messages,
      idGenerator: msgFakes.sequentialMessagingIdGenerator(),
    });
    const channel = msgFakes.makeChannel({ id: 'chan-9', organizationId: ORG, members: ['user-1'] });
    channels.seed(ORG, channel);
    orgByChannel.set('chan-9', ORG);

    // The write SUCCEEDS even though indexing failed.
    const posted = await messaging.post(ctx, 'chan-9', { body: 'resilient message survives' });
    expect(posted.body).toBe('resilient message survives');
    const stored = await messageStore.findById(ctx, posted.id);
    expect(stored).not.toBeNull();

    // The failure was recorded (observable for monitoring/retry), not thrown.
    expect(recorder.count).toBe(1);
    expect(recorder.last?.type).toBe('messaging');
    expect(recorder.last?.externalId).toBe(posted.id);
    expect(recorder.last?.organizationId).toBe(ORG);
  });
});

describe('Unified search authorization (Req 29.2)', () => {
  it('(d) excludes content the principal is not authorized to see', async () => {
    const h = makeHarness();

    await h.knowledgeHub.createPage(principal, {
      projectId: PROJECT,
      title: 'Public Plan',
      content: khFakes.makeRichContent('confidential roadmap public copy'),
    });
    await h.knowledgeHub.createPage(principal, {
      projectId: PROJECT,
      title: 'Secret Plan',
      content: khFakes.makeRichContent('confidential roadmap secret copy'),
    });

    // An authorizer that denies the "Secret Plan" result, simulating a
    // permission-restricted page the searcher nonetheless surfaced.
    const denySecret: UnifiedSearchAuthorizer = {
      authorize: (_principal, _type, candidate) => !candidate.title.includes('Secret'),
    };

    const result = await searchOver(h, denySecret).search('confidential', principal);
    const titles = result.groups.flatMap((g) => g.items.map((i) => i.title));
    expect(titles).toContain('Public Plan');
    expect(titles).not.toContain('Secret Plan');
  });
});
