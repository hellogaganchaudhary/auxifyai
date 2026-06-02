/**
 * End-to-end integration tests for the two wired platform flows (Req 4.1, 24.1,
 * 29.1).
 *
 * These exercise — through the real, assembled services — the two cross-module
 * paths that tasks 27.1 and 27.2 wired together, assembling the SAME real
 * services the dedicated module tests assemble, but driving BOTH flows over the
 * SAME shared `knowledge_chunk` Vector_Store so the two paths are proven to
 * compose:
 *
 *   1. STREAMING-CHAT-WITH-RAG (Req 4.1, 24.1): the real Chat_Pipeline
 *      (Budget_Manager, Content_Safety_Filter, RagRetriever, ChatService over a
 *      fake router, Streaming_Engine, Analytics_Service) runs one knowledge-
 *      enabled chat send end to end. A fully-attributed `knowledge_chunk` seeded
 *      in the shared Vector_Store is retrieved, its text is injected into the
 *      model context, and the streamed token events arrive before a completion
 *      event carrying model + tokens + cost.
 *
 *   2. CROSS-MODULE INGESTION + UNIFIED SEARCH (Req 29.1): the three real native
 *      services (Knowledge_Hub, Messaging, Document_Management) write a page, a
 *      message, and a document — all carrying one shared search term — through
 *      the real native-ingestion bridge, so each is indexed as a retrievable,
 *      attributed `knowledge_chunk`. A real Unified_Search_Service over the SAME
 *      index then surfaces content from every module for the term, grouped by
 *      content type and confined to the requesting principal's Organization.
 *
 *   3. TYING THE FLOWS TOGETHER: content ingested through the native bridge is
 *      ALSO retrievable by the RagRetriever, since the one `knowledge_chunk`
 *      index backs both RAG and unified search.
 *
 * Each component module's in-memory fakes are imported directly from its own
 * `./fakes.js` (never the package barrel), matching the established convention;
 * the e2e directory is the clean place to assemble the real wired flows because
 * it can reach every module's fakes by a relative import.
 */

import { describe, expect, it } from 'vitest';

import type { ModelInfo, Principal, TenantContext } from '@auxify/types';

import { AnalyticsService } from '../analytics/index.js';
import { InMemoryMetricStore } from '../analytics/fakes.js';
import { BudgetManager } from '../budget/index.js';
import {
  CapturingAuditRecorder as BudgetAuditRecorder,
  InMemoryBudgetStore,
  InMemoryUsageStore,
  MutableBudgetClock,
} from '../budget/fakes.js';
import { ChatService } from '../chat/index.js';
import {
  FakeRoutingPort,
  InMemoryChatConversationStore,
  InMemoryChatMessageStore,
  makeModel,
  makePrincipal,
  makeRoutedResult,
  sequentialMessageIdGenerator,
} from '../chat/fakes.js';
import { ChatPipeline, type ChatPipelineOptions } from '../chat-pipeline/chat-pipeline.js';
import { CapturingEventSink, NoopPartialResponsePersister, makeKnowledgeChunkRecord } from '../chat-pipeline/fakes.js';
import type { ChatPipelineRequest } from '../chat-pipeline/types.js';
import { ContentSafetyFilter } from '../content-safety/index.js';
import {
  CapturingAuditRecorder as SafetyAuditRecorder,
  CapturingReviewQueue,
  FakeSafetyClassifier,
} from '../content-safety/fakes.js';
import { DocumentManagementService } from '../document-management/index.js';
import * as dmsFakes from '../document-management/fakes.js';
import { DeterministicEmbedder } from '../file-processor/fakes.js';
import { RagRetriever } from '../knowledge/index.js';
import { AllowAllChunkAuthorizer, InMemoryKnowledgeStore } from '../knowledge/fakes.js';
import { KnowledgeHubService } from '../knowledge-hub/index.js';
import * as khFakes from '../knowledge-hub/fakes.js';
import { MessagingService } from '../messaging/index.js';
import * as msgFakes from '../messaging/fakes.js';
import {
  createNativeIngestionBridge,
  createUnifiedSearchService,
} from '../native-ingestion/index.js';
import { StreamingEngine } from '../streaming/index.js';
import { EMBEDDING_DIMENSIONS, InMemoryObjectStore, InMemoryVectorStore } from '../storage/index.js';

const ORG = 'org-1';
const USER = 'user-1';
const TEAM = 'team-1';
const PROJECT = 'proj-1';
const CHANNEL = 'chan-1';
const CONVERSATION = 'conv-1';

/** A standard-tier model that serves the chat send in the streaming-with-RAG flow. */
const SERVED_MODEL: ModelInfo = makeModel('standard', {
  id: 'gpt-standard',
  provider: 'azure',
  cost: { per1kInputTokens: 1, per1kOutputTokens: 2 },
});

// ---------------------------------------------------------------------------
// Flow 1 — streaming chat with RAG end to end (Req 4.1, 24.1)
// ---------------------------------------------------------------------------

/** A fully-wired Chat_Pipeline harness assembled from the real request-path services. */
interface ChatHarness {
  pipeline: ChatPipeline;
  router: FakeRoutingPort;
  vectors: InMemoryVectorStore;
  ctx: TenantContext;
  principal: Principal;
}

/** Assemble the REAL Chat_Pipeline over the component modules' in-memory fakes. */
function makeChatHarness(assistantText = 'the answer is Paris'): ChatHarness {
  const principal = makePrincipal({ organizationId: ORG, userId: USER, teamIds: [TEAM] });
  const ctx: TenantContext = { organizationId: ORG, userId: USER, teamId: TEAM };

  // Budget_Manager (real) over in-memory fakes.
  const budget = new BudgetManager({
    budgets: new InMemoryBudgetStore(),
    usage: new InMemoryUsageStore(),
    audit: new BudgetAuditRecorder(),
    clock: new MutableBudgetClock(Date.UTC(2026, 0, 1)),
  });

  // Content_Safety_Filter (real).
  const contentSafety = new ContentSafetyFilter({
    classifier: new FakeSafetyClassifier(),
    auditRecorder: new SafetyAuditRecorder(),
    reviewQueue: new CapturingReviewQueue(),
  });

  // RagRetriever (real) over a shared in-memory Vector_Store + embedder.
  const vectors = new InMemoryVectorStore();
  const rag = new RagRetriever({
    embedder: new DeterministicEmbedder(),
    vectorStore: vectors,
    authorizer: new AllowAllChunkAuthorizer(),
  });

  // ChatService (real) over a fake router returning a canned routed result.
  const conversations = new InMemoryChatConversationStore(() => new Date(Date.UTC(2026, 0, 1)));
  conversations.seed({
    id: CONVERSATION,
    organizationId: ORG,
    projectId: PROJECT,
    ownerId: USER,
    title: 'Seeded',
    folderId: null,
    archived: false,
    shareToken: null,
    shareMode: null,
    personaId: null,
    activeModelId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const messages = new InMemoryChatMessageStore((id) => (id === CONVERSATION ? ORG : undefined));
  const router = new FakeRoutingPort(
    makeRoutedResult(SERVED_MODEL, {
      text: assistantText,
      usage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 222,
    }),
  );
  const chat = new ChatService({
    router,
    conversations,
    messages,
    idGenerator: sequentialMessageIdGenerator(),
  });

  // Streaming_Engine + Analytics_Service (real).
  const streaming = new StreamingEngine({ persister: new NoopPartialResponsePersister() });
  const analytics = new AnalyticsService({ metrics: new InMemoryMetricStore() });

  const opts: ChatPipelineOptions = { budget, contentSafety, rag, chat, streaming, analytics };
  return { pipeline: new ChatPipeline(opts), router, vectors, ctx, principal };
}

/** Build a knowledge-enabled chat pipeline request for the streaming-with-RAG flow. */
function makeRagRequest(h: ChatHarness, content: string, sink: CapturingEventSink): ChatPipelineRequest {
  return {
    ctx: h.ctx,
    principal: h.principal,
    send: { conversationId: CONVERSATION, content, modelId: SERVED_MODEL.id },
    sink,
    modelTier: 'standard',
    knowledgeEnabled: true,
    correlationId: 'corr-e2e-1',
  };
}

describe('Wired flow 1 — streaming chat with RAG end to end (Req 4.1, 24.1)', () => {
  it('relays token events THEN a completion carrying model + tokens + cost, with the retrieved chunk injected into the model context', async () => {
    const h = makeChatHarness();
    const sink = new CapturingEventSink();

    // Seed a fully-attributed knowledge_chunk in the shared Vector_Store the
    // real RagRetriever reads (Req 24.1).
    await h.vectors.upsert([
      makeKnowledgeChunkRecord({
        id: 'chunk-paris',
        organizationId: ORG,
        text: 'The capital of France is Paris.',
      }),
    ]);

    const result = await h.pipeline.run(makeRagRequest(h, 'capital of France', sink));

    expect(result.ok).toBe(true);

    // (Req 4.1) Token events were relayed BEFORE the completion event.
    expect(sink.tokenEvents.length).toBeGreaterThan(0);
    expect(sink.deliveredText).toBe('the answer is Paris');
    const completion = sink.completion;
    expect(completion).toBeDefined();
    expect(completion?.model).toBe(SERVED_MODEL.id);
    expect(completion?.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    // cost = 100/1000*1 + 50/1000*2 = 0.2
    expect(completion?.cost).toBeCloseTo(0.2, 10);
    // The completion is the LAST event emitted (tokens then completion).
    expect(sink.events.at(-1)?.type).toBe('completion');

    // (Req 24.1) RAG retrieval found the attributed chunk and injected its text
    // into the model's system prompt.
    expect(result.retrieval?.found).toBe(true);
    expect(result.retrieval?.chunks).toHaveLength(1);
    expect(result.retrieval?.chunks[0]?.attribution.sourceTitle).toBe('Onboarding Guide');
    expect(h.router.lastRequest?.systemPrompt).toContain('The capital of France is Paris.');
    expect(h.router.lastRequest?.systemPrompt).toContain('Onboarding Guide');
  });
});

// ---------------------------------------------------------------------------
// Flow 2 — cross-module ingestion + unified search end to end (Req 29.1)
// ---------------------------------------------------------------------------

/** A search term carried by content written in every native module. */
const TERM = 'quarterly';

/** The acting principal in {@link ORG}. */
const principal: Principal = {
  userId: USER,
  organizationId: ORG,
  roles: ['standard_user'],
  teamIds: [],
  projectIds: [PROJECT],
  allowedModels: [],
  premiumAuthorized: false,
};

/** The messaging tenant context for the acting principal. */
const ctx: TenantContext = { organizationId: ORG, userId: USER };

/** A probe vector; the in-memory Vector_Store returns every org-scoped record regardless of score. */
const PROBE = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

/** A `k` larger than any test population so a query returns every matching record. */
const ALL = 100_000;

/** A fully-wired native-ingestion harness: three real module services over one bridge. */
function makeNativeHarness() {
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
  const knowledgeHub = new KnowledgeHubService({
    pages: new khFakes.InMemoryPageStore(khFakes.monotonicClock()),
    audit: new khFakes.CapturingAuditRecorder(),
    ingestion: wiring.bridge.pages,
    notifier: new khFakes.CapturingPageNotifier(),
    authorizer: new khFakes.AllowAllPageAuthorizer(),
    idGenerator: khFakes.sequentialPageIdGenerator(),
  });

  // Messaging_Service wired with the bridge's message emitter adapter (Req 27.9).
  const channels = new msgFakes.InMemoryChannelStore();
  const orgByChannel = new Map<string, string>();
  const messaging = new MessagingService({
    channels,
    messages: new msgFakes.InMemoryChannelMessageStore((id) => orgByChannel.get(id)),
    audit: new msgFakes.CapturingMessagingAuditRecorder(),
    ingestion: wiring.bridge.messages,
    idGenerator: msgFakes.sequentialMessagingIdGenerator(),
  });
  channels.seed(
    ORG,
    msgFakes.makeChannel({ id: CHANNEL, organizationId: ORG, members: [USER], visibility: 'public' }),
  );
  orgByChannel.set(CHANNEL, ORG);

  // Document_Management_Service wired with the bridge's document emitter adapter
  // (Req 28.5). Shares the SAME Object_Store the bridge's content reader reads.
  const documents = new DocumentManagementService({
    documents: new dmsFakes.InMemoryDocumentStore(dmsFakes.monotonicClock()),
    objectStore: objects,
    audit: new dmsFakes.CapturingAuditRecorder(),
    ingestion: wiring.bridge.documents,
    backup: new dmsFakes.InMemoryDocumentBackupStore(),
    compliance: new dmsFakes.RecordingComplianceManager(),
    authorizer: new dmsFakes.AllowAllDocAuthorizer(),
    idGenerator: dmsFakes.sequentialDocumentIdGenerator(),
  });

  return { embedder, vectors, knowledgeHub, messaging, documents };
}

/** Write a page, a message, and a document — all carrying {@link TERM} — into the harness. */
async function seedAllModules(h: ReturnType<typeof makeNativeHarness>): Promise<void> {
  await h.knowledgeHub.createPage(principal, {
    projectId: PROJECT,
    title: 'Quarterly Plan',
    content: khFakes.makeRichContent(`${TERM} planning roadmap for the platform team`),
  });
  await h.messaging.post(ctx, CHANNEL, { body: `${TERM} planning sync notes and action items` });
  await h.documents.upload(principal, {
    projectId: PROJECT,
    name: 'plan.txt',
    contentType: 'text/plain',
    bytes: new TextEncoder().encode(`${TERM} planning report contents for review`),
  });
}

describe('Wired flow 2 — cross-module ingestion + unified search end to end (Req 29.1)', () => {
  it('surfaces content from EVERY native module for a shared term, grouped by content type', async () => {
    const h = makeNativeHarness();
    await seedAllModules(h);

    const search = createUnifiedSearchService({ embedder: h.embedder, vectorStore: h.vectors });
    const result = await search.search(TERM, principal);

    // (Req 29.1) Every module's content type is represented in the grouped results.
    const types = new Set(result.groups.map((g) => g.type));
    expect(types.has('knowledge_page')).toBe(true);
    expect(types.has('message')).toBe(true);
    expect(types.has('document')).toBe(true);

    // The page and document surface by their human-readable titles.
    const pageGroup = result.groups.find((g) => g.type === 'knowledge_page');
    expect(pageGroup?.items.some((i) => i.title === 'Quarterly Plan')).toBe(true);
    const documentGroup = result.groups.find((g) => g.type === 'document');
    expect(documentGroup?.items.some((i) => i.title === 'plan.txt')).toBe(true);
    const messageGroup = result.groups.find((g) => g.type === 'message');
    expect(messageGroup?.items.length).toBeGreaterThan(0);

    // Every surfaced item points back to its owning module via its content type.
    for (const group of result.groups) {
      for (const item of group.items) {
        expect(item.location.resourceType).toBe(group.type);
      }
    }
  });

  it('confines unified-search results to the requesting principal\'s Organization (a foreign-org principal sees none)', async () => {
    const h = makeNativeHarness();
    await seedAllModules(h);

    const search = createUnifiedSearchService({ embedder: h.embedder, vectorStore: h.vectors });
    const foreign: Principal = { ...principal, organizationId: 'org-2', userId: 'user-9' };
    const result = await search.search(TERM, foreign);

    expect(result.groups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Flow 3 — the two flows compose over ONE knowledge_chunk index (reinforcement)
// ---------------------------------------------------------------------------

describe('Wired flows compose — native-ingested content is also RAG-retrievable (Req 24.1, 29.1)', () => {
  it('retrieves content ingested through the native bridge via the RagRetriever over the same index', async () => {
    const h = makeNativeHarness();
    await seedAllModules(h);

    // Sanity: the native writes are indexed as knowledge_chunk records.
    const indexed = await h.vectors.query(PROBE, { organizationId: ORG, ownerType: 'knowledge_chunk' }, ALL);
    expect(indexed.length).toBeGreaterThanOrEqual(3);

    // The SAME index that backs unified search also backs RAG retrieval.
    const rag = new RagRetriever({
      embedder: h.embedder,
      vectorStore: h.vectors,
      authorizer: new AllowAllChunkAuthorizer(),
      // The deterministic embedder maps the query/chunk by text length, so relax
      // the relevance threshold to assert reachability rather than tuned ranking.
      defaultRelevanceThreshold: 0,
    });
    const retrieval = await rag.retrieve(`${TERM} planning report contents for review`, principal);

    expect(retrieval.found).toBe(true);
    expect(retrieval.chunks.length).toBeGreaterThan(0);
    // Every retrieved chunk carries complete attribution back to its source.
    for (const chunk of retrieval.chunks) {
      expect(chunk.attribution.sourceId).not.toBe('');
      expect(chunk.attribution.link).not.toBe('');
    }
  });
});
