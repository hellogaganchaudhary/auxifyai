/**
 * Unit tests for the Chat_Service send path, model switch, and title generation
 * (Req 3.10, 5.8, and the chat send path of Req 4).
 *
 * These exercise {@link ChatService} against deterministic fakes (a
 * {@link FakeRoutingPort} returning a canned {@link RoutedChatResult},
 * {@link InMemoryChatConversationStore}/{@link InMemoryChatMessageStore}, and a
 * {@link FakeTitleGenerator}) — no real providers, network, or database —
 * covering:
 *   - `send` persists the user and assistant messages, the assistant carrying
 *     the served model, token counts, and cost from the routed outcome (Req 3.9,
 *     44.6);
 *   - the effective model routed is request → active model → Auto Mode (Req 3.10);
 *   - `switchModel` updates the conversation's active model and leaves prior
 *     messages unchanged (Req 3.10, the Property 15 invariant);
 *   - auto-title runs only on the first exchange of a still-untitled
 *     conversation and never overwrites a user-assigned title (Req 5.8);
 *   - not-found conversations raise {@link ConversationNotFoundError}.
 */

import { describe, expect, it } from 'vitest';

import { ConversationNotFoundError } from '../conversations/index.js';
import { AUTO_MODEL_ID } from '../router/index.js';

import { ChatService } from './chat-service.js';
import {
  FakeRoutingPort,
  FakeTitleGenerator,
  InMemoryChatConversationStore,
  InMemoryChatMessageStore,
  makeModel,
  makePrincipal,
  makeRoutedResult,
  sequentialMessageIdGenerator,
} from './fakes.js';
import { DeterministicTitleGenerator, FALLBACK_TITLE, normalizeTitle } from './title-generator.js';

const CTX = { organizationId: 'org-1', userId: 'user-1' } as const;
const PRINCIPAL = makePrincipal({ premiumAuthorized: true, allowedModels: [] });

/** Assemble a Chat_Service over fakes with a seeded conversation. */
function setup(
  options: {
    title?: string;
    activeModelId?: string | null;
    routed?: ReturnType<typeof makeRoutedResult> | ((reqModelId: string) => ReturnType<typeof makeRoutedResult>);
    titleGenerator?: FakeTitleGenerator;
    conversationId?: string;
    organizationId?: string;
  } = {},
): {
  service: ChatService;
  conversations: InMemoryChatConversationStore;
  messages: InMemoryChatMessageStore;
  router: FakeRoutingPort;
  titleGenerator: FakeTitleGenerator;
  conversationId: string;
} {
  const conversationId = options.conversationId ?? 'conv-1';
  const organizationId = options.organizationId ?? CTX.organizationId;
  const conversations = new InMemoryChatConversationStore(() => new Date('2026-01-01T00:00:00.000Z'));
  conversations.seed({
    id: conversationId,
    organizationId,
    projectId: 'proj-1',
    ownerId: 'user-1',
    title: options.title ?? '',
    folderId: null,
    archived: false,
    shareToken: null,
    shareMode: null,
    personaId: null,
    activeModelId: options.activeModelId ?? null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const messages = new InMemoryChatMessageStore((id) =>
    id === conversationId ? organizationId : undefined,
  );

  const model = makeModel('standard', { id: 'model-standard' });
  const decide =
    options.routed ??
    ((reqModelId: string) =>
      makeRoutedResult(makeModel('standard', { id: reqModelId === AUTO_MODEL_ID ? 'auto-picked' : reqModelId })));
  const router = new FakeRoutingPort(
    typeof decide === 'function'
      ? (req) => (decide as (id: string) => ReturnType<typeof makeRoutedResult>)(req.modelId)
      : decide,
  );
  void model;

  const titleGenerator = options.titleGenerator ?? new FakeTitleGenerator('Generated title');
  const service = new ChatService({
    router,
    conversations,
    messages,
    titleGenerator,
    idGenerator: sequentialMessageIdGenerator(),
  });
  return { service, conversations, messages, router, titleGenerator, conversationId };
}

describe('ChatService.send — persistence of the exchange (Req 3.9, 44.6)', () => {
  it('persists the user message and the assistant message with model/tokens/cost', async () => {
    const routed = makeRoutedResult(makeModel('standard', { id: 'model-standard' }), {
      usage: { inputTokens: 100, outputTokens: 50 },
      latencyMs: 123,
      text: 'Hello there!',
    });
    const { service, messages, conversationId } = setup({ routed });

    const result = await service.send(
      CTX,
      { conversationId, content: 'Hi', modelId: 'model-standard' },
      PRINCIPAL,
    );

    // User message persisted with the supplied content.
    expect(result.userMessage.role).toBe('user');
    expect(result.userMessage.content).toEqual([{ type: 'markdown', data: { text: 'Hi' } }]);

    // Assistant message persisted with model, token counts, cost, latency.
    expect(result.assistantMessage.role).toBe('assistant');
    expect(result.assistantMessage.model).toBe('model-standard');
    expect(result.assistantMessage.inputTokens).toBe(100);
    expect(result.assistantMessage.outputTokens).toBe(50);
    expect(result.assistantMessage.latencyMs).toBe(123);
    // cost = 100/1000*1 + 50/1000*2 = 0.1 + 0.1 = 0.2 (makeModel costs 1/2).
    expect(result.assistantMessage.cost).toBeCloseTo(0.2, 10);
    expect(result.assistantMessage.content).toEqual([
      { type: 'markdown', data: { text: 'Hello there!' } },
    ]);

    // Both messages are durably stored, in order, linked parent→child.
    const stored = await messages.listByConversation(CTX, conversationId);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[1]?.parentId).toBe(stored[0]?.id);

    // The result surfaces the decision, outcome, usage, and chunks for relay.
    expect(result.decision.model.id).toBe('model-standard');
    expect(result.outcome.cost).toBeCloseTo(0.2, 10);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.finishReason).toBe('stop');
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it('sends prior history plus the new user message to the router, oldest first', async () => {
    const { service, router, conversationId } = setup({ title: 'Existing' });

    await service.send(CTX, { conversationId, content: 'first', modelId: 'model-standard' }, PRINCIPAL);
    await service.send(CTX, { conversationId, content: 'second', modelId: 'model-standard' }, PRINCIPAL);

    // The second send routes the whole history so far: user1, assistant1, user2.
    const lastReq = router.lastRequest;
    expect(lastReq?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(lastReq?.messages.at(0)?.content).toBe('first');
    expect(lastReq?.messages.at(-1)?.content).toBe('second');
  });

  it('throws ConversationNotFoundError for an unknown conversation', async () => {
    const { service } = setup();
    await expect(
      service.send(CTX, { conversationId: 'missing', content: 'hi' }, PRINCIPAL),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it('isolates by tenant: a conversation in another org is not found', async () => {
    const { service, conversationId } = setup({ organizationId: 'org-2' });
    await expect(
      service.send(CTX, { conversationId, content: 'hi', modelId: 'model-standard' }, PRINCIPAL),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe('ChatService.send — effective model selection (Req 3.10)', () => {
  it('routes the explicitly requested model when one is given', async () => {
    const { service, router, conversationId } = setup({ activeModelId: 'active-model', title: 'x' });
    await service.send(CTX, { conversationId, content: 'hi', modelId: 'explicit-model' }, PRINCIPAL);
    expect(router.lastRequest?.modelId).toBe('explicit-model');
  });

  it("falls back to the conversation's active model when none is requested", async () => {
    const { service, router, conversationId } = setup({ activeModelId: 'active-model', title: 'x' });
    await service.send(CTX, { conversationId, content: 'hi' }, PRINCIPAL);
    expect(router.lastRequest?.modelId).toBe('active-model');
  });

  it('falls back to Auto Mode when neither a request model nor an active model exists', async () => {
    const { service, router, conversationId } = setup({ activeModelId: null, title: 'x' });
    await service.send(CTX, { conversationId, content: 'hi' }, PRINCIPAL);
    expect(router.lastRequest?.modelId).toBe(AUTO_MODEL_ID);
  });
});

describe('ChatService.switchModel — affects subsequent messages only (Req 3.10)', () => {
  it('updates the active model and leaves previously-persisted messages unchanged', async () => {
    const { service, messages, conversations, conversationId } = setup({ title: 'x' });

    // First exchange on model-a.
    await service.send(CTX, { conversationId, content: 'q1', modelId: 'model-a' }, PRINCIPAL);
    const beforeSwitch = messages.snapshot();
    expect(beforeSwitch.find((m) => m.role === 'assistant')?.model).toBe('model-a');

    // Switch the active model.
    await service.switchModel(CTX, conversationId, 'model-b');
    const conv = await conversations.findById(CTX, conversationId);
    expect(conv?.activeModelId).toBe('model-b');

    // Prior messages are byte-for-byte unchanged after the switch.
    const afterSwitch = messages.snapshot();
    expect(afterSwitch.slice(0, beforeSwitch.length)).toEqual(beforeSwitch);

    // A subsequent send with no explicit model now uses model-b.
    await service.send(CTX, { conversationId, content: 'q2' }, PRINCIPAL);
    const finalMessages = messages.snapshot();
    const assistantModels = finalMessages.filter((m) => m.role === 'assistant').map((m) => m.model);
    expect(assistantModels).toEqual(['model-a', 'model-b']);

    // The first exchange's messages are still intact (history preserved).
    expect(finalMessages.slice(0, beforeSwitch.length)).toEqual(beforeSwitch);
  });

  it('throws ConversationNotFoundError when switching a model on an unknown conversation', async () => {
    const { service } = setup();
    await expect(service.switchModel(CTX, 'missing', 'model-b')).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });
});

describe('ChatService auto-title (Req 5.8)', () => {
  it('generates and applies a title after the first exchange when untitled', async () => {
    const titleGenerator = new FakeTitleGenerator('Summarized title');
    const { service, conversations, conversationId } = setup({ title: '', titleGenerator });

    const result = await service.send(
      CTX,
      { conversationId, content: 'How do I deploy?', modelId: 'model-standard' },
      PRINCIPAL,
    );

    expect(result.title).toBe('Summarized title');
    const conv = await conversations.findById(CTX, conversationId);
    expect(conv?.title).toBe('Summarized title');
    expect(titleGenerator.count).toBe(1);
  });

  it('does not overwrite a user-assigned title', async () => {
    const titleGenerator = new FakeTitleGenerator('Should not be used');
    const { service, conversations, conversationId } = setup({
      title: 'My title',
      titleGenerator,
    });

    const result = await service.send(
      CTX,
      { conversationId, content: 'hi', modelId: 'model-standard' },
      PRINCIPAL,
    );

    expect(result.title).toBeUndefined();
    const conv = await conversations.findById(CTX, conversationId);
    expect(conv?.title).toBe('My title');
    expect(titleGenerator.count).toBe(0);
  });

  it('only auto-titles the first exchange, not subsequent ones', async () => {
    const titleGenerator = new FakeTitleGenerator('First-exchange title');
    const { service, conversations, conversationId } = setup({ title: '', titleGenerator });

    await service.send(CTX, { conversationId, content: 'q1', modelId: 'model-standard' }, PRINCIPAL);
    const second = await service.send(
      CTX,
      { conversationId, content: 'q2', modelId: 'model-standard' },
      PRINCIPAL,
    );

    // Title generated exactly once, on the first exchange.
    expect(titleGenerator.count).toBe(1);
    expect(second.title).toBeUndefined();
    const conv = await conversations.findById(CTX, conversationId);
    expect(conv?.title).toBe('First-exchange title');
  });

  it('generateTitle returns the existing title without regenerating when set', async () => {
    const titleGenerator = new FakeTitleGenerator('new');
    const { service, conversationId } = setup({ title: 'User title', titleGenerator });
    const title = await service.generateTitle(CTX, conversationId, PRINCIPAL);
    expect(title).toBe('User title');
    expect(titleGenerator.count).toBe(0);
  });

  it('generateTitle generates and applies a title for an untitled conversation', async () => {
    const titleGenerator = new FakeTitleGenerator((source) => `Re: ${source.userText}`);
    const { service, messages, conversations, conversationId } = setup({
      title: '',
      titleGenerator,
    });

    // Seed a first exchange directly (without triggering send's auto-title).
    await messages.create(CTX, {
      id: 'u1',
      conversationId,
      role: 'user',
      content: [{ type: 'markdown', data: { text: 'the question' } }],
    });
    await messages.create(CTX, {
      id: 'a1',
      conversationId,
      role: 'assistant',
      content: [{ type: 'markdown', data: { text: 'the answer' } }],
    });

    const title = await service.generateTitle(CTX, conversationId, PRINCIPAL);
    expect(title).toBe('Re: the question');
    const conv = await conversations.findById(CTX, conversationId);
    expect(conv?.title).toBe('Re: the question');
  });

  it('throws ConversationNotFoundError for generateTitle on an unknown conversation', async () => {
    const { service } = setup();
    await expect(service.generateTitle(CTX, 'missing', PRINCIPAL)).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });
});

describe('DeterministicTitleGenerator and normalizeTitle (Req 5.8)', () => {
  it('derives the first sentence of the user message', async () => {
    const gen = new DeterministicTitleGenerator();
    const title = await gen.generate(
      { conversationId: 'c', userText: 'Deploy the app. Then test it.', assistantText: 'ok' },
      PRINCIPAL,
    );
    expect(title).toBe('Deploy the app.');
  });

  it('falls back to a default title for empty input', async () => {
    const gen = new DeterministicTitleGenerator();
    const title = await gen.generate(
      { conversationId: 'c', userText: '   ', assistantText: '' },
      PRINCIPAL,
    );
    expect(title).toBe(FALLBACK_TITLE);
  });

  it('normalizeTitle collapses whitespace and caps length with an ellipsis', () => {
    expect(normalizeTitle('  hello   world  ')).toBe('hello world');
    const long = 'word '.repeat(40);
    const capped = normalizeTitle(long);
    expect(capped.length).toBeLessThanOrEqual(80);
    expect(capped.endsWith('…')).toBe(true);
  });

  it('normalizeTitle returns the fallback for all-whitespace input', () => {
    expect(normalizeTitle('   \n\t ')).toBe(FALLBACK_TITLE);
  });
});
