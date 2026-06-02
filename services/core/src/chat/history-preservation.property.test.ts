/**
 * Property test for history-preserving edit / branch / regenerate (Req 6.1-6.3).
 *
 * Feature: auxify-ai-platform, Property 22: Editing, branching, and
 * regeneration preserve prior history.
 * Validates: Requirements 6.1, 6.2, 6.3.
 *
 * For ANY arbitrary sequence of {@link ChatService.editMessage},
 * {@link ChatService.branch}, and {@link ChatService.regenerate} operations
 * targeting arbitrary existing messages, this drives the *real*
 * {@link ChatService} over the in-memory chat fakes (no real providers, network,
 * or database) and asserts the history-preservation invariant of Property 22:
 *
 *   0. **Append-only history (the heart of the property).** Immediately before
 *      every operation a snapshot of every persisted message is taken; after the
 *      operation every one of those prior messages is still present and
 *      byte-for-byte identical (same id, parentId, role, content, recorded
 *      model/tokens/cost, rating, order). Nothing is ever lost or mutated — new
 *      messages are only ever *added*.
 *   1. **Edit forks a new branch, original thread intact (Req 6.1).** Editing a
 *      message creates a brand-new message that is a sibling of the edited one
 *      (it references the edited message's parent as the branch point) carrying
 *      the new content; the original message is untouched. When the edited
 *      message is a user turn, a fresh assistant reply is added parented to the
 *      edited message.
 *   2. **Branch references the selected message as parent (Req 6.2).** Branching
 *      at a selected message creates a child whose `parentId` is exactly that
 *      message, leaving the selected message intact.
 *   3. **Regenerate retains the prior response (Req 6.3).** Regenerating a
 *      response adds a new assistant message as a sibling under the same parent
 *      while the prior response remains present and unchanged, so both coexist.
 *
 * Finally a global tree-integrity invariant is checked: every message's
 * `parentId` either is `null` or refers to a still-present message (no orphans),
 * and every parent chain terminates (no cycles) — proving the branch tree stays
 * well-formed across all operations.
 *
 * The {@link FakeRoutingPort} echoes the requested model id back through the
 * routed outcome so any re-routed reply is self-consistent; the conversation is
 * seeded with a title so auto-titling never perturbs the run.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import type { MessageRecord } from '../repositories/index.js';
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
const NUM_RUNS = 150;

const ORG = 'org-1';
const CONVERSATION_ID = 'conv-1';
const CTX: TenantContext = { organizationId: ORG, userId: 'user-1' };
const PRINCIPAL = makePrincipal({ premiumAuthorized: true, allowedModels: [] });

/** The pool of model ids edits and regenerations choose from. */
const modelArb = fc.constantFrom('model-a', 'model-b', 'model-c', 'model-d');

/**
 * One generated operation. `sel` is a non-negative index taken modulo the
 * current candidate count at execution time, so the generator can target an
 * arbitrary existing message without knowing ids ahead of time.
 */
type Op =
  | { kind: 'edit'; sel: number; explicit: string | null }
  | { kind: 'branch'; sel: number }
  | { kind: 'regenerate'; sel: number; model: string };

const selArb = fc.nat({ max: 100000 });

const editOpArb: fc.Arbitrary<Op> = fc
  .tuple(selArb, fc.option(modelArb, { nil: null }))
  .map(([sel, explicit]) => ({ kind: 'edit', sel, explicit }));

const branchOpArb: fc.Arbitrary<Op> = selArb.map((sel) => ({ kind: 'branch', sel }));

const regenerateOpArb: fc.Arbitrary<Op> = fc
  .tuple(selArb, modelArb)
  .map(([sel, model]) => ({ kind: 'regenerate', sel, model }));

/** Sequences of arbitrary operations against the conversation's branch tree. */
const opsArb: fc.Arbitrary<Op[]> = fc.array(
  fc.oneof(editOpArb, branchOpArb, regenerateOpArb),
  { minLength: 1, maxLength: 20 },
);

/** Assemble a Chat_Service over fresh fakes with a titled conversation. */
function setup(): { service: ChatService; messages: InMemoryChatMessageStore } {
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
  // Echo the requested model id into the routed outcome so any re-routed reply
  // is self-consistent (Auto Mode resolves to a concrete picked model id).
  const router = new FakeRoutingPort((req) =>
    makeRoutedResult(
      makeModel('standard', { id: req.modelId === AUTO_MODEL_ID ? 'auto-picked' : req.modelId }),
      { text: `reply from ${req.modelId}` },
    ),
  );
  const service = new ChatService({
    router,
    conversations,
    messages,
    idGenerator: sequentialMessageIdGenerator(),
  });
  return { service, messages };
}

/** Assert every message present before an operation survives it byte-for-byte. */
function assertHistoryPreserved(before: MessageRecord[], after: MessageRecord[]): void {
  const afterById = new Map(after.map((m) => [m.id, m] as const));
  for (const prior of before) {
    // Present and byte-for-byte unchanged: id, parentId, role, content,
    // recorded model/tokens/cost, rating, timestamp — nothing mutated.
    expect(afterById.get(prior.id)).toEqual(prior);
  }
  // History is append-only: it never shrinks.
  expect(after.length).toBeGreaterThanOrEqual(before.length);
}

/** Assert the branch tree is well-formed: no dangling parents and no cycles. */
function assertTreeWellFormed(messages: MessageRecord[]): void {
  const byId = new Map(messages.map((m) => [m.id, m] as const));
  for (const start of messages) {
    if (start.parentId !== null) {
      // No orphans: every referenced parent is still present.
      expect(byId.has(start.parentId)).toBe(true);
    }
    // Walking the parent chain terminates (no cycles).
    const seen = new Set<string>();
    let current: MessageRecord | undefined = start;
    while (current !== undefined) {
      expect(seen.has(current.id)).toBe(false);
      seen.add(current.id);
      const parentId: string | null = current.parentId;
      current = parentId === null ? undefined : byId.get(parentId);
    }
  }
}

/** Seed two chained exchanges so the initial branch tree has depth to target. */
async function seedHistory(service: ChatService): Promise<void> {
  await service.send(
    CTX,
    { conversationId: CONVERSATION_ID, content: 'first question', modelId: 'model-a' },
    PRINCIPAL,
  );
  await service.send(
    CTX,
    { conversationId: CONVERSATION_ID, content: 'second question', modelId: 'model-b' },
    PRINCIPAL,
  );
}

describe('Feature: auxify-ai-platform, Property 22: Editing, branching, and regeneration preserve prior history', () => {
  it('keeps all prior history intact and additive across arbitrary edit/branch/regenerate sequences (Validates: Requirements 6.1, 6.2, 6.3)', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const { service, messages } = setup();
        await seedHistory(service);

        for (const op of ops) {
          const before = messages.snapshot();
          const beforeIds = new Set(before.map((m) => m.id));

          if (op.kind === 'edit') {
            // Edit any existing message (Req 6.1).
            const target = before[op.sel % before.length]!;
            const editedText = `edited ${op.sel}`;
            const branch = await service.editMessage(
              CTX,
              target.id,
              editedText,
              PRINCIPAL,
              op.explicit !== null ? { modelId: op.explicit } : {},
            );
            const after = messages.snapshot();

            assertHistoryPreserved(before, after);

            // A brand-new message forks from the edited message's parent (the
            // branch point); the original thread is left intact.
            expect(beforeIds.has(branch.rootMessage.id)).toBe(false);
            expect(branch.rootMessage.parentId).toBe(target.parentId);
            expect(branch.branchPointId).toBe(target.parentId);
            expect(branch.sourceMessageId).toBe(target.id);
            expect(branch.rootMessage.role).toBe(target.role);
            expect(branch.rootMessage.content).toEqual([
              { type: 'markdown', data: { text: editedText } },
            ]);

            if (target.role === 'user') {
              // A fresh reply is re-routed on the new branch, parented to the edit.
              expect(branch.assistantMessage).toBeDefined();
              expect(branch.assistantMessage?.role).toBe('assistant');
              expect(branch.assistantMessage?.parentId).toBe(branch.rootMessage.id);
              expect(after.length).toBe(before.length + 2);
            } else {
              expect(branch.assistantMessage).toBeUndefined();
              expect(after.length).toBe(before.length + 1);
            }
          } else if (op.kind === 'branch') {
            // Branch at any selected message (Req 6.2).
            const target = before[op.sel % before.length]!;
            const branch = await service.branch(CTX, target.id);
            const after = messages.snapshot();

            assertHistoryPreserved(before, after);

            // The child references the selected message as its parent.
            expect(beforeIds.has(branch.rootMessage.id)).toBe(false);
            expect(branch.rootMessage.parentId).toBe(target.id);
            expect(branch.branchPointId).toBe(target.id);
            expect(branch.sourceMessageId).toBe(target.id);
            expect(branch.rootMessage.role).toBe(target.role);
            expect(branch.rootMessage.content).toEqual(target.content);
            expect(after.length).toBe(before.length + 1);
          } else {
            // Regenerate an existing assistant response (Req 6.3).
            const candidates = before.filter((m) => m.role === 'assistant');
            if (candidates.length === 0) continue;
            const target = candidates[op.sel % candidates.length]!;
            const result = await service.regenerate(CTX, target.id, op.model, PRINCIPAL);
            const after = messages.snapshot();

            assertHistoryPreserved(before, after);

            // A new sibling response is added under the same parent; the prior
            // response is retained unchanged so both coexist.
            expect(beforeIds.has(result.assistantMessage.id)).toBe(false);
            expect(result.assistantMessage.role).toBe('assistant');
            expect(result.assistantMessage.parentId).toBe(target.parentId);
            expect(result.priorMessage.id).toBe(target.id);
            expect(result.requestedModelId).toBe(op.model);

            const siblings = after.filter(
              (m) => m.role === 'assistant' && m.parentId === target.parentId,
            );
            expect(siblings.some((m) => m.id === target.id)).toBe(true);
            expect(siblings.some((m) => m.id === result.assistantMessage.id)).toBe(true);
            expect(after.length).toBe(before.length + 1);
          }
        }

        // The branch tree stays well-formed after every operation.
        assertTreeWellFormed(messages.snapshot());
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
