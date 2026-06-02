/**
 * Property test for the mid-conversation model switch (Req 3.10).
 *
 * Feature: auxify-ai-platform, Property 15: Mid-conversation model switch
 * preserves history.
 * Validates: Requirements 3.10.
 *
 * For ANY arbitrary sequence of {@link ChatService.send}s (some naming an
 * explicit model, some not) interleaved with {@link ChatService.switchModel}
 * calls, this drives the *real* {@link ChatService} over the in-memory chat
 * fakes and asserts the history-preservation invariant of Req 3.10:
 *
 *   1. **Effective model follows the switch.** A `switchModel(M)` makes `M` the
 *      conversation's active model, so every SUBSEQUENT send that does NOT name
 *      a model routes with effective model `M` (the {@link FakeRoutingPort}
 *      received `req.modelId === M`). Sends BEFORE the switch are unaffected.
 *   2. **History is never rewritten by a switch.** A snapshot of every persisted
 *      message taken immediately before each `switchModel` is byte-for-byte
 *      identical afterwards — every prior message's recorded model, content,
 *      ids, and chronological order are unchanged. This is the core invariant.
 *   3. **An explicit per-send model overrides the active model for that send
 *      only.** It does not change the conversation's active model, so a later
 *      unspecified send still uses the switched-to active model.
 *   4. **History grows by exactly two messages per send** (the user message and
 *      the assistant reply), and prior entries keep their recorded model.
 *
 * The effective model per send is asserted against an INDEPENDENT oracle
 * re-implemented here (explicit request → active model → Auto Mode), never the
 * module under test. The {@link FakeRoutingPort} echoes the routed `modelId`
 * into `outcome.modelId`/`decision.model` so the model recorded on each
 * assistant message equals the effective model routed for that send. The
 * conversation is seeded with a title so auto-titling never perturbs the run.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

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

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

const ORG = 'org-1';
const CONVERSATION_ID = 'conv-1';
const CTX: TenantContext = { organizationId: ORG, userId: 'user-1' };
const PRINCIPAL = makePrincipal({ premiumAuthorized: true, allowedModels: [] });

/** The pool of model ids explicit sends and switches choose from. */
const modelArb = fc.constantFrom('model-a', 'model-b', 'model-c', 'model-d');

/** One generated operation against the conversation. */
type Op = { kind: 'send'; explicit: string | null } | { kind: 'switch'; model: string };

/** A send, sometimes naming an explicit model, sometimes deferring to the active one. */
const sendOpArb: fc.Arbitrary<Op> = fc
  .option(modelArb, { nil: null })
  .map((explicit) => ({ kind: 'send', explicit }));

/** A mid-conversation model switch. */
const switchOpArb: fc.Arbitrary<Op> = modelArb.map((model) => ({ kind: 'switch', model }));

/** Sequences mix sends (weighted higher to grow history) with switches. */
const opsArb: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof({ weight: 3, arbitrary: sendOpArb }, { weight: 2, arbitrary: switchOpArb }),
  { minLength: 1, maxLength: 24 },
);

/** Assemble a Chat_Service over fresh fakes with a titled, no-active-model conversation. */
function setup(): {
  service: ChatService;
  messages: InMemoryChatMessageStore;
  router: FakeRoutingPort;
} {
  const conversations = new InMemoryChatConversationStore(
    () => new Date('2026-01-01T00:00:00.000Z'),
  );
  conversations.seed({
    id: CONVERSATION_ID,
    organizationId: ORG,
    projectId: 'proj-1',
    ownerId: 'user-1',
    title: 'seeded title', // non-empty so auto-titling never runs
    folderId: null,
    archived: false,
    shareToken: null,
    shareMode: null,
    personaId: null,
    activeModelId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const messages = new InMemoryChatMessageStore((id) => (id === CONVERSATION_ID ? ORG : undefined));
  // Echo the routed model id into outcome.modelId/decision.model so the model
  // recorded on each assistant message equals the effective model routed.
  const router = new FakeRoutingPort((req) =>
    makeRoutedResult(makeModel('standard', { id: req.modelId })),
  );
  const service = new ChatService({
    router,
    conversations,
    messages,
    idGenerator: sequentialMessageIdGenerator(),
  });
  return { service, messages, router };
}

describe('Feature: auxify-ai-platform, Property 15: Mid-conversation model switch preserves history', () => {
  it('applies a switch to subsequent sends only and never rewrites prior history (Validates: Requirements 3.10)', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const { service, messages, router } = setup();

        // Independent oracle: the conversation's active model (null until the
        // first switch) and the effective model expected per send in order.
        let activeModel: string | null = null;
        const expectedEffectivePerSend: string[] = [];

        for (const op of ops) {
          if (op.kind === 'send') {
            // Effective model (Req 3.10): explicit request → active model → Auto.
            const expectedEffective = op.explicit ?? activeModel ?? AUTO_MODEL_ID;
            expectedEffectivePerSend.push(expectedEffective);

            const countBefore = messages.snapshot().length;
            await service.send(
              CTX,
              {
                conversationId: CONVERSATION_ID,
                content: `msg ${expectedEffectivePerSend.length}`,
                ...(op.explicit !== null ? { modelId: op.explicit } : {}),
              },
              PRINCIPAL,
            );

            // (1)/(3) The router received the expected effective model for this
            // send. An explicit model overrides the active one for this send
            // only; it must NOT have mutated the active-model oracle.
            expect(router.lastRequest?.modelId).toBe(expectedEffective);

            // (4) History grew by exactly the user + assistant pair.
            expect(messages.snapshot().length).toBe(countBefore + 2);
          } else {
            // (2) Prior persisted messages must survive the switch untouched.
            const before = messages.snapshot();
            await service.switchModel(CTX, CONVERSATION_ID, op.model);
            const after = messages.snapshot();

            // Byte-for-byte identical: same ids, content, recorded model, order.
            expect(after).toEqual(before);

            // Subsequent unspecified sends now route to this model.
            activeModel = op.model;
          }
        }

        // (1) Every routed send, in order, used the oracle's effective model.
        expect(router.calls.map((c) => c.req.modelId)).toEqual(expectedEffectivePerSend);

        // (4) The full history is exactly one user + assistant per send, in
        // order, and each assistant retains the model recorded at send time —
        // proving switches never retroactively rewrote any prior message.
        const snapshot = messages.snapshot();
        expect(snapshot.length).toBe(expectedEffectivePerSend.length * 2);
        expect(snapshot.map((m) => m.role)).toEqual(
          expectedEffectivePerSend.flatMap(() => ['user', 'assistant']),
        );
        expect(snapshot.filter((m) => m.role === 'assistant').map((m) => m.model)).toEqual(
          expectedEffectivePerSend,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
