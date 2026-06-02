/**
 * Unit tests for the Conversation_Manager (Req 5, 6.6).
 *
 * These drive the manager against the in-memory store/message fakes and a
 * capturing audit recorder, proving each acceptance criterion with concrete
 * examples and edge cases:
 *   - create persists owner/Project/timestamp/title and is audited (Req 5.1, 5.3);
 *   - list returns recent-first, date-grouped conversations (Req 5.2);
 *   - rename/archive/delete apply the change and audit it (Req 5.3);
 *   - assignFolder associates the folder and reflects it in listing (Req 5.4);
 *   - search ranks across titles + message content (Req 5.5);
 *   - createShareLink mints a unique token and enforces the mode (Req 5.6);
 *   - export produces each md/pdf/json/html format (Req 5.7);
 *   - pin marks a message pinned and makes pinned messages retrievable (Req 6.6).
 *
 * The exhaustive over-all-inputs ordering guarantee lives in the companion
 * property test (`conversation-list-ordering.property.test.ts`).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  ConversationNotFoundError,
  MessageNotFoundError,
  UnknownExportFormatError,
} from './errors.js';
import {
  CapturingAuditRecorder,
  InMemoryConversationStore,
  InMemoryMessageStore,
  makeConversationRecord,
  makeMessageRecord,
  sequentialIdGenerator,
} from './fakes.js';
import { ConversationManager } from './conversation-manager.js';

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };
const otherOrgCtx: TenantContext = { organizationId: 'org-2', userId: 'user-9' };

/** A fixed clock at 2026-03-15T12:00:00Z for deterministic timestamps/labels. */
function fixedClock(iso = '2026-03-15T12:00:00.000Z'): () => Date {
  return () => new Date(iso);
}

/**
 * Build a manager wired to fresh in-memory fakes. The message store resolves a
 * conversation's Organization through the conversation store so parent-tenant
 * scoping is modelled.
 */
function makeManager(now = fixedClock()) {
  const conversations = new InMemoryConversationStore(now);
  // Track org per conversation id for the message store's parent-tenant scope.
  const orgByConversation = new Map<string, string>();
  const messages = new InMemoryMessageStore((id) => orgByConversation.get(id));
  const audit = new CapturingAuditRecorder();
  const manager = new ConversationManager({
    conversations,
    messages,
    audit,
    idGenerator: sequentialIdGenerator(),
    now,
  });
  return { manager, conversations, messages, audit, orgByConversation };
}

describe('ConversationManager.create (Req 5.1)', () => {
  it('persists owner, owning project, timestamp, and title, and audits the creation', async () => {
    const { manager, audit } = makeManager();

    const created = await manager.create(ctx, { projectId: 'proj-7', title: 'Planning' });

    expect(created.id).toBe('conv-1');
    expect(created.projectId).toBe('proj-7');
    expect(created.ownerId).toBe('user-1');
    expect(created.title).toBe('Planning');
    expect(created.archived).toBe(false);
    expect(created.createdAt).toBe('2026-03-15T12:00:00.000Z');
    expect(created.updatedAt).toBe('2026-03-15T12:00:00.000Z');

    expect(audit.withAction('conversation.create')).toHaveLength(1);
    expect(audit.last?.event.resourceId).toBe('conv-1');
    expect(audit.last?.event.resourceType).toBe('conversation');
  });

  it('defaults the owner to the acting user and the title to empty', async () => {
    const { manager } = makeManager();
    const created = await manager.create(ctx, { projectId: 'proj-1' });
    expect(created.ownerId).toBe('user-1');
    expect(created.title).toBe('');
  });
});

describe('ConversationManager.list (Req 5.2)', () => {
  it('returns the owner conversations recent-first and grouped by date', async () => {
    const { manager, conversations } = makeManager(fixedClock('2026-03-15T12:00:00.000Z'));
    // Seed three conversations across two days with fixed timestamps.
    conversations.seed(
      makeConversationRecord({ id: 'c-old', updatedAt: '2026-03-13T09:00:00.000Z' }),
    );
    conversations.seed(
      makeConversationRecord({ id: 'c-yest', updatedAt: '2026-03-14T08:00:00.000Z' }),
    );
    conversations.seed(
      makeConversationRecord({ id: 'c-today-early', updatedAt: '2026-03-15T07:00:00.000Z' }),
    );
    conversations.seed(
      makeConversationRecord({ id: 'c-today-late', updatedAt: '2026-03-15T11:00:00.000Z' }),
    );

    const groups = await manager.list(ctx);

    expect(groups.map((g) => g.dateLabel)).toEqual(['Today', 'Yesterday', '2026-03-13']);
    // Today group: most-recent first.
    expect(groups[0]?.conversations.map((c) => c.id)).toEqual(['c-today-late', 'c-today-early']);
    expect(groups[1]?.conversations.map((c) => c.id)).toEqual(['c-yest']);
    expect(groups[2]?.conversations.map((c) => c.id)).toEqual(['c-old']);
  });

  it('returns an empty listing when the owner has no conversations', async () => {
    const { manager } = makeManager();
    expect(await manager.list(ctx)).toEqual([]);
  });

  it('does not include another organization conversations', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(
      makeConversationRecord({ id: 'foreign', organizationId: 'org-2', ownerId: 'user-1' }),
    );
    expect(await manager.list(ctx)).toEqual([]);
  });
});

describe('ConversationManager.rename/archive/delete (Req 5.3)', () => {
  it('renames a conversation and audits it', async () => {
    const { manager, conversations, audit } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1', title: 'Old' }));

    await manager.rename(ctx, 'c1', 'New title');

    const after = await conversations.findById(ctx, 'c1');
    expect(after?.title).toBe('New title');
    expect(audit.withAction('conversation.rename')).toHaveLength(1);
    expect(audit.last?.event.metadata?.title).toBe('New title');
  });

  it('archives a conversation and audits it', async () => {
    const { manager, conversations, audit } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1' }));

    await manager.archive(ctx, 'c1');

    expect((await conversations.findById(ctx, 'c1'))?.archived).toBe(true);
    expect(audit.withAction('conversation.archive')).toHaveLength(1);
  });

  it('deletes a conversation and audits it', async () => {
    const { manager, conversations, audit } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1' }));

    await manager.delete(ctx, 'c1');

    expect(await conversations.findById(ctx, 'c1')).toBeNull();
    expect(audit.withAction('conversation.delete')).toHaveLength(1);
  });

  it('throws and does not audit when renaming a missing conversation', async () => {
    const { manager, audit } = makeManager();
    await expect(manager.rename(ctx, 'nope', 'x')).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
    expect(audit.count).toBe(0);
  });

  it('throws when deleting a conversation owned by another organization', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1', organizationId: 'org-2' }));
    await expect(manager.delete(ctx, 'c1')).rejects.toBeInstanceOf(ConversationNotFoundError);
    // The other org can delete it.
    await expect(manager.delete(otherOrgCtx, 'c1')).resolves.toBeUndefined();
  });
});

describe('ConversationManager.assignFolder (Req 5.4)', () => {
  it('associates the folder and reflects it in the listing, and audits it', async () => {
    const { manager, conversations, audit } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1' }));

    await manager.assignFolder(ctx, 'c1', 'folder-42');

    const groups = await manager.list(ctx);
    const listed = groups.flatMap((g) => g.conversations).find((c) => c.id === 'c1');
    expect(listed?.folderId).toBe('folder-42');
    expect(audit.withAction('conversation.assign_folder')).toHaveLength(1);
    expect(audit.last?.event.metadata?.folderId).toBe('folder-42');
  });
});

describe('ConversationManager.search (Req 5.5)', () => {
  it('ranks title matches above body-only matches across the owner conversations', async () => {
    const { manager, conversations, messages, orgByConversation } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c-title', title: 'Quarterly budget review' }));
    conversations.seed(makeConversationRecord({ id: 'c-body', title: 'Random chat' }));
    conversations.seed(makeConversationRecord({ id: 'c-none', title: 'Unrelated' }));
    orgByConversation.set('c-title', 'org-1');
    orgByConversation.set('c-body', 'org-1');
    orgByConversation.set('c-none', 'org-1');
    messages.seed(
      makeMessageRecord({
        id: 'm1',
        conversationId: 'c-body',
        content: [{ type: 'markdown', data: { text: 'we should discuss the budget soon' } }],
      }),
    );

    const hits = await manager.search(ctx, 'budget');

    expect(hits.map((h) => h.conversation.id)).toEqual(['c-title', 'c-body']);
    expect(hits[0]?.titleMatch).toBe(true);
    expect(hits[1]?.messageMatches).toBe(1);
  });

  it('returns nothing for a blank query', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1', title: 'something' }));
    expect(await manager.search(ctx, '   ')).toEqual([]);
  });
});

describe('ConversationManager.createShareLink (Req 5.6)', () => {
  it('mints a unique token, enforces the mode, persists both, and audits it', async () => {
    const { manager, conversations, audit } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1' }));

    const share = await manager.createShareLink(ctx, 'c1', 'collab');

    expect(share.conversationId).toBe('c1');
    expect(share.token).toBe('share-1');
    expect(share.mode).toBe('collab');

    const after = await conversations.findById(ctx, 'c1');
    expect(after?.shareToken).toBe('share-1');
    expect(after?.shareMode).toBe('collab');
    expect(audit.withAction('conversation.share')).toHaveLength(1);
    expect(audit.last?.event.metadata?.mode).toBe('collab');
  });

  it('mints distinct tokens for distinct conversations', async () => {
    const { manager, conversations } = makeManager();
    conversations.seed(makeConversationRecord({ id: 'c1' }));
    conversations.seed(makeConversationRecord({ id: 'c2' }));

    const a = await manager.createShareLink(ctx, 'c1', 'read');
    const b = await manager.createShareLink(ctx, 'c2', 'read');

    expect(a.token).not.toBe(b.token);
  });

  it('throws for a missing conversation', async () => {
    const { manager } = makeManager();
    await expect(manager.createShareLink(ctx, 'nope', 'read')).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });
});

describe('ConversationManager.export (Req 5.7)', () => {
  function seedExportable(m: ReturnType<typeof makeManager>) {
    m.conversations.seed(makeConversationRecord({ id: 'c1', title: 'Export me' }));
    m.orgByConversation.set('c1', 'org-1');
    m.messages.seed(
      makeMessageRecord({
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: [{ type: 'markdown', data: { text: 'hello <b>world</b>' } }],
        createdAt: '2026-03-15T10:00:00.000Z',
      }),
    );
    m.messages.seed(
      makeMessageRecord({
        id: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        content: [{ type: 'markdown', data: { text: 'hi there' } }],
        createdAt: '2026-03-15T10:01:00.000Z',
      }),
    );
  }

  it('produces Markdown with the title and message content', async () => {
    const m = makeManager();
    seedExportable(m);
    const artifact = await m.manager.export(ctx, 'c1', 'md');
    expect(artifact.format).toBe('md');
    expect(artifact.contentType).toBe('text/markdown');
    expect(artifact.filename).toBe('conversation-c1.md');
    expect(artifact.content).toContain('# Export me');
    expect(artifact.content).toContain('hi there');
  });

  it('produces round-trippable JSON', async () => {
    const m = makeManager();
    seedExportable(m);
    const artifact = await m.manager.export(ctx, 'c1', 'json');
    expect(artifact.contentType).toBe('application/json');
    const parsed = JSON.parse(artifact.content) as {
      conversation: { id: string };
      messages: unknown[];
    };
    expect(parsed.conversation.id).toBe('c1');
    expect(parsed.messages).toHaveLength(2);
  });

  it('produces HTML that escapes message content', async () => {
    const m = makeManager();
    seedExportable(m);
    const artifact = await m.manager.export(ctx, 'c1', 'html');
    expect(artifact.contentType).toBe('text/html');
    expect(artifact.content).toContain('<!DOCTYPE html>');
    // The literal markup in the message must be escaped, not embedded.
    expect(artifact.content).toContain('hello &lt;b&gt;world&lt;/b&gt;');
    expect(artifact.content).not.toContain('hello <b>world</b>');
  });

  it('produces a PDF representation labelled as such with the pdf content type', async () => {
    const m = makeManager();
    seedExportable(m);
    const artifact = await m.manager.export(ctx, 'c1', 'pdf');
    expect(artifact.contentType).toBe('application/pdf');
    expect(artifact.filename).toBe('conversation-c1.pdf');
    expect(artifact.content).toContain('%PDF-1.4');
    expect(artifact.content).toContain('# Export me');
  });

  it('throws for an unsupported format', async () => {
    const m = makeManager();
    seedExportable(m);
    await expect(
      // Force an invalid format through a cast to model programmatic misuse.
      m.manager.export(ctx, 'c1', 'docx' as unknown as 'md'),
    ).rejects.toBeInstanceOf(UnknownExportFormatError);
  });

  it('throws for a missing conversation', async () => {
    const m = makeManager();
    await expect(m.manager.export(ctx, 'nope', 'md')).rejects.toBeInstanceOf(
      ConversationNotFoundError,
    );
  });
});

describe('ConversationManager.pin and listPinned (Req 6.6)', () => {
  it('marks a message pinned, makes it retrievable, and audits the pin', async () => {
    const m = makeManager();
    m.conversations.seed(makeConversationRecord({ id: 'c1' }));
    m.orgByConversation.set('c1', 'org-1');
    m.messages.seed(makeMessageRecord({ id: 'm1', conversationId: 'c1' }));
    m.messages.seed(makeMessageRecord({ id: 'm2', conversationId: 'c1' }));

    await m.manager.pin(ctx, 'm1');

    const pinned = await m.manager.listPinned(ctx, 'c1');
    expect(pinned.map((p) => p.id)).toEqual(['m1']);
    expect(m.audit.withAction('message.pin')).toHaveLength(1);
    expect(m.audit.last?.event.resourceType).toBe('message');
    expect(m.audit.last?.event.metadata?.conversationId).toBe('c1');
  });

  it('throws and does not audit when pinning a missing message', async () => {
    const m = makeManager();
    await expect(m.manager.pin(ctx, 'nope')).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(m.audit.count).toBe(0);
  });

  it('throws when pinning a message in another organization conversation', async () => {
    const m = makeManager();
    m.orgByConversation.set('c1', 'org-2');
    m.messages.seed(makeMessageRecord({ id: 'm1', conversationId: 'c1' }));
    await expect(m.manager.pin(ctx, 'm1')).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});
