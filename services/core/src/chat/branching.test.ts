/**
 * Unit tests for the Chat_Service editing, branching, regeneration, comparison,
 * and rating (Req 6.1-6.5).
 *
 * These exercise {@link ChatService} against deterministic fakes (a
 * {@link FakeRoutingPort} returning a canned {@link RoutedChatResult},
 * {@link InMemoryChatConversationStore}/{@link InMemoryChatMessageStore}) — no
 * real providers, network, or database — covering the design's branch-tree
 * behaviour and, above all, the history-preservation invariant of Property 22
 * (task 8.8): editing, branching, and regeneration never mutate or delete prior
 * messages; new branches/messages reference parents via `parentId`.
 *
 *   - editMessage forks a NEW branch from the edited message's parent and
 *     re-routes a reply, leaving the original message thread intact (Req 6.1);
 *   - branch creates a CHILD referencing the selected message as its parent
 *     (Req 6.2);
 *   - regenerate adds a NEW response as a sibling while retaining the prior one
 *     (Req 6.3);
 *   - compare fans one prompt out to each selected model and returns a response
 *     per model (Req 6.4);
 *   - rate persists the thumbs-up/neutral/thumbs-down rating on the message
 *     (Req 6.5);
 *   - not-found messages/conversations raise the typed errors.
 */

import { describe, expect, it } from 'vitest';

import { ConversationNotFoundError, MessageNotFoundError } from '../conversations/index.js';
import { AUTO_MODEL_ID } from '../router/index.js';

import { ChatService } from './chat-service.js';
import {
  FakeRoutingPort,
  InMemoryChatConversationStore,
  InMemoryChatMessageStore,
  makeModel,
  makePrincipal,
  makeRoutedResult,
  sequentialMessageIdGenerator,
} from './fakes.js';

const CTX = { organizationId: 'org-1', userId: 'user-1' } as const;
const PRINCIPAL = makePrincipal({ premiumAuthorized: true, allowedModels: [] });

/** Assemble a Chat_Service over fakes with a seeded conversation. */
function setup(
  options: { activeModelId?: string | null; conversationId?: string; organizationId?: string } = {},
): {
  service: ChatService;
  conversations: InMemoryChatConversationStore;
  messages: InMemoryChatMessageStore;
  router: FakeRoutingPort;
  conversationId: string;
} {
  const conversationId = options.conversationId ?? 'conv-1';
  const organizationId = options.organizationId ?? CTX.organizationId;
  const conversations = new InMemoryChatConversationStore(
    () => new Date('2026-01-01T00:00:00.000Z'),
  );
  conversations.seed({
    id: conversationId,
    organizationId,
    projectId: 'proj-1',
    ownerId: 'user-1',
    title: 'Existing',
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

  // Echo the requested model back through the routed outcome so tests can
  // assert the effective model and the served text per model.
  const router = new FakeRoutingPort((req) =>
    makeRoutedResult(
      makeModel('standard', {
        id: req.modelId === AUTO_MODEL_ID ? 'auto-picked' : req.modelId,
      }),
      { text: `reply from ${req.modelId}` },
    ),
  );

  const service = new ChatService({
    router,
    conversations,
    messages,
    idGenerator: sequentialMessageIdGenerator(),
  });
  return { service, conversations, messages, router, conversationId };
}

/** Seed a first user→assistant exchange and return the two persisted ids. */
async function seedExchange(
  service: ChatService,
  conversationId: string,
  content = 'original question',
): Promise<{ userId: string; assistantId: string }> {
  const result = await service.send(
    CTX,
    { conversationId, content, modelId: 'model-a' },
    PRINCIPAL,
  );
  return { userId: result.userMessage.id, assistantId: result.assistantMessage.id };
}

describe('ChatService.editMessage — forks a new branch, preserves the original (Req 6.1)', () => {
  it('creates a sibling of the edited message sharing its parent and leaves the original intact', async () => {
    const { service, messages, conversationId } = setup();
    const { userId, assistantId } = await seedExchange(service, conversationId);
    const before = messages.snapshot();

    const branch = await service.editMessage(CTX, userId, 'edited question', PRINCIPAL);

    // The edited message is a NEW message (not the original) sharing the
    // original user message's parent (here: null — the root).
    expect(branch.rootMessage.id).not.toBe(userId);
    expect(branch.rootMessage.role).toBe('user');
    expect(branch.rootMessage.parentId).toBe(null);
    expect(branch.branchPointId).toBe(null);
    expect(branch.sourceMessageId).toBe(userId);
    expect(branch.rootMessage.content).toEqual([
      { type: 'markdown', data: { text: 'edited question' } },
    ]);

    // A fresh assistant reply was re-routed on the new branch, parented to the
    // edited message (not to the original).
    expect(branch.assistantMessage?.role).toBe('assistant');
    expect(branch.assistantMessage?.parentId).toBe(branch.rootMessage.id);

    // The original messages are byte-for-byte unchanged and still present.
    const after = messages.snapshot();
    const original = after.find((m) => m.id === userId);
    const originalAssistant = after.find((m) => m.id === assistantId);
    expect(original).toEqual(before.find((m) => m.id === userId));
    expect(originalAssistant).toEqual(before.find((m) => m.id === assistantId));
    expect(after.length).toBe(before.length + 2); // edited user + new assistant
  });

  it('routes the edited turn through the active model when no model is given', async () => {
    const { service, router, conversationId } = setup({ activeModelId: 'active-model' });
    const { userId } = await seedExchange(service, conversationId);
    await service.editMessage(CTX, userId, 'edited', PRINCIPAL);
    expect(router.lastRequest?.modelId).toBe('active-model');
  });

  it('routes the edited turn through an explicit model when supplied', async () => {
    const { service, router, conversationId } = setup({ activeModelId: 'active-model' });
    const { userId } = await seedExchange(service, conversationId);
    await service.editMessage(CTX, userId, 'edited', PRINCIPAL, { modelId: 'explicit-model' });
    expect(router.lastRequest?.modelId).toBe('explicit-model');
  });

  it('does not re-route a reply when the edited message is an assistant message', async () => {
    const { service, messages, conversationId } = setup();
    const { assistantId } = await seedExchange(service, conversationId);
    const before = messages.snapshot();

    const branch = await service.editMessage(CTX, assistantId, 'edited reply', PRINCIPAL);

    expect(branch.rootMessage.role).toBe('assistant');
    expect(branch.assistantMessage).toBeUndefined();
    // Only the edited assistant sibling was added; no extra reply.
    expect(messages.snapshot().length).toBe(before.length + 1);
  });

  it('throws MessageNotFoundError for an unknown message', async () => {
    const { service } = setup();
    await expect(service.editMessage(CTX, 'missing', 'x', PRINCIPAL)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('does not find a message in another tenant', async () => {
    const { service, conversationId } = setup({ organizationId: 'org-2' });
    // Seed must happen in org-2's ctx; use a separate setup instead.
    const otherCtx = { organizationId: 'org-2', userId: 'user-2' } as const;
    const { userId } = await seedExchangeWithCtx(service, conversationId, otherCtx);
    await expect(service.editMessage(CTX, userId, 'x', PRINCIPAL)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });
});

/** Seed an exchange under an explicit tenant context (for cross-tenant tests). */
async function seedExchangeWithCtx(
  service: ChatService,
  conversationId: string,
  ctx: { organizationId: string; userId: string },
): Promise<{ userId: string; assistantId: string }> {
  const result = await service.send(
    ctx,
    { conversationId, content: 'q', modelId: 'model-a' },
    PRINCIPAL,
  );
  return { userId: result.userMessage.id, assistantId: result.assistantMessage.id };
}

describe('ChatService.branch — child references the selected message as parent (Req 6.2)', () => {
  it('creates a child whose parentId is the selected message, leaving it intact', async () => {
    const { service, messages, conversationId } = setup();
    const { assistantId } = await seedExchange(service, conversationId);
    const before = messages.snapshot();

    const branch = await service.branch(CTX, assistantId);

    expect(branch.rootMessage.parentId).toBe(assistantId);
    expect(branch.branchPointId).toBe(assistantId);
    expect(branch.sourceMessageId).toBe(assistantId);
    // The selected message is unchanged; exactly one child was added.
    const after = messages.snapshot();
    expect(after.find((m) => m.id === assistantId)).toEqual(
      before.find((m) => m.id === assistantId),
    );
    expect(after.length).toBe(before.length + 1);
  });

  it('copies the selected message role and content onto the branch root', async () => {
    const { service, conversationId } = setup();
    const { userId } = await seedExchange(service, conversationId, 'the prompt');
    const branch = await service.branch(CTX, userId);
    expect(branch.rootMessage.role).toBe('user');
    expect(branch.rootMessage.content).toEqual([
      { type: 'markdown', data: { text: 'the prompt' } },
    ]);
  });

  it('throws MessageNotFoundError for an unknown message', async () => {
    const { service } = setup();
    await expect(service.branch(CTX, 'missing')).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});

describe('ChatService.regenerate — retains the prior response (Req 6.3)', () => {
  it('creates a sibling assistant message under the same parent and keeps the prior one', async () => {
    const { service, messages, conversationId } = setup();
    const { userId, assistantId } = await seedExchange(service, conversationId);
    const before = messages.snapshot();

    const result = await service.regenerate(CTX, assistantId, 'model-b', PRINCIPAL);

    // New response is a sibling: same parent (the user message) as the prior one.
    expect(result.assistantMessage.id).not.toBe(assistantId);
    expect(result.assistantMessage.parentId).toBe(userId);
    expect(result.priorMessage.id).toBe(assistantId);
    expect(result.requestedModelId).toBe('model-b');
    expect(result.assistantMessage.model).toBe('model-b');

    // The prior assistant message is unchanged and still present.
    const after = messages.snapshot();
    expect(after.find((m) => m.id === assistantId)).toEqual(
      before.find((m) => m.id === assistantId),
    );
    // Both responses now coexist under the same parent.
    const siblings = after.filter((m) => m.role === 'assistant' && m.parentId === userId);
    expect(siblings.map((m) => m.id).sort()).toEqual(
      [assistantId, result.assistantMessage.id].sort(),
    );
  });

  it('throws MessageNotFoundError for an unknown message', async () => {
    const { service } = setup();
    await expect(service.regenerate(CTX, 'missing', 'model-b', PRINCIPAL)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });
});

describe('ChatService.compare — fans the prompt to each model (Req 6.4)', () => {
  it('submits the prompt to each model and returns one response per model', async () => {
    const { service, messages, conversationId } = setup();

    const results = await service.compare(
      CTX,
      { conversationId, content: 'Explain branches' },
      ['model-a', 'model-b', 'model-c'],
      PRINCIPAL,
    );

    expect(results.map((r) => r.modelId)).toEqual(['model-a', 'model-b', 'model-c']);
    // Each response carries the served model and the per-model text.
    expect(results.map((r) => r.assistantMessage.model)).toEqual(['model-a', 'model-b', 'model-c']);
    expect(results[0]?.assistantMessage.content).toEqual([
      { type: 'markdown', data: { text: 'reply from model-a' } },
    ]);

    // A single shared user prompt was persisted; every response is its sibling child.
    const stored = messages.snapshot();
    const userMessages = stored.filter((m) => m.role === 'user');
    expect(userMessages.length).toBe(1);
    const promptId = userMessages[0]?.id;
    const responses = stored.filter((m) => m.role === 'assistant');
    expect(responses.length).toBe(3);
    expect(responses.every((m) => m.parentId === promptId)).toBe(true);
  });

  it('records each route call with the corresponding model', async () => {
    const { service, router, conversationId } = setup();
    await service.compare(CTX, { conversationId, content: 'hi' }, ['m1', 'm2'], PRINCIPAL);
    expect(router.calls.map((c) => c.req.modelId)).toEqual(['m1', 'm2']);
  });

  it('throws ConversationNotFoundError for an unknown conversation', async () => {
    const { service } = setup();
    await expect(
      service.compare(CTX, { conversationId: 'missing', content: 'hi' }, ['m1'], PRINCIPAL),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe('ChatService.rate — persists the rating (Req 6.5)', () => {
  it('persists thumbs-up/neutral/thumbs-down on the message', async () => {
    const { service, messages, conversationId } = setup();
    const { assistantId } = await seedExchange(service, conversationId);

    const up = await service.rate(CTX, assistantId, 'up');
    expect(up.rating).toBe('up');
    expect((await messages.findById(CTX, assistantId))?.rating).toBe('up');

    const down = await service.rate(CTX, assistantId, 'down');
    expect(down.rating).toBe('down');

    const neutral = await service.rate(CTX, assistantId, 'neutral');
    expect(neutral.rating).toBe('neutral');
    expect((await messages.findById(CTX, assistantId))?.rating).toBe('neutral');
  });

  it('does not mutate any other field when rating', async () => {
    const { service, messages, conversationId } = setup();
    const { assistantId } = await seedExchange(service, conversationId);
    const before = (await messages.findById(CTX, assistantId))!;

    await service.rate(CTX, assistantId, 'up');
    const after = (await messages.findById(CTX, assistantId))!;
    expect({ ...after, rating: before.rating }).toEqual(before);
  });

  it('throws MessageNotFoundError for an unknown message', async () => {
    const { service } = setup();
    await expect(service.rate(CTX, 'missing', 'up')).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});

describe('history preservation across edit + regenerate (Property 22 spirit, Req 6.1-6.3)', () => {
  it('never removes or mutates the original messages after an edit then a regenerate', async () => {
    const { service, messages, conversationId } = setup();
    const { userId, assistantId } = await seedExchange(service, conversationId);
    const original = messages.snapshot();

    const branch = await service.editMessage(CTX, userId, 'edited', PRINCIPAL);
    await service.regenerate(CTX, branch.assistantMessage!.id, 'model-c', PRINCIPAL);

    const after = messages.snapshot();
    // Every original message is still present and unchanged.
    for (const msg of original) {
      expect(after.find((m) => m.id === msg.id)).toEqual(msg);
    }
    // Originals are a strict prefix of history (append-only tree).
    expect(after.length).toBeGreaterThan(original.length);
    expect(after.find((m) => m.id === userId)).toBeDefined();
    expect(after.find((m) => m.id === assistantId)).toBeDefined();
  });
});
