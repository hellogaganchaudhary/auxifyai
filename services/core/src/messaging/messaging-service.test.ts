/**
 * Unit tests for the Messaging_Service (Req 27.1-27.9).
 *
 * These drive the service against the in-memory store/message fakes, a
 * capturing audit recorder, and a capturing ingestion emitter, proving each
 * acceptance criterion with concrete examples and edge cases:
 *   - createChannel persists name/owner/visibility/members and is audited (Req 27.1);
 *   - post persists, delivers in real time, and indexes the content (Req 27.2, 27.9);
 *   - reply associates with the parent and maintains thread order (Req 27.3);
 *   - inactive recipients are notified, active viewers are not (Req 27.4);
 *   - shareFile stores the file via DMS and attaches the reference (Req 27.5);
 *   - search returns authorized, relevance-ranked messages (Req 27.6);
 *   - aiAssist invokes the Chat_Service and posts the response (Req 27.7);
 *   - private channels restrict access to members, with denials audited (Req 27.8);
 *   - tenant scoping confines every operation to the caller's Organization (Req 1.2).
 */

import { describe, expect, it } from 'vitest';

import type { TenantContext } from '@auxify/types';

import {
  ChannelAccessDeniedError,
  ChannelMessageNotFoundError,
  ChannelNotFoundError,
} from './errors.js';
import {
  CapturingIngestionEmitter,
  CapturingMessagingAuditRecorder,
  EchoChatAssistant,
  InMemoryChannelMessageStore,
  InMemoryChannelStore,
  MapPresenceTracker,
  RecordingNotifier,
  RecordingRealtimeDelivery,
  StubFileStore,
  makeChannel,
  sequentialMessagingIdGenerator,
} from './fakes.js';
import { MessagingService } from './messaging-service.js';

const ctx: TenantContext = { organizationId: 'org-1', userId: 'user-1' };
const otherOrgCtx: TenantContext = { organizationId: 'org-2', userId: 'user-9' };

/** A fixed clock at 2026-03-15T12:00:00Z for deterministic timestamps. */
function fixedClock(iso = '2026-03-15T12:00:00.000Z'): () => Date {
  return () => new Date(iso);
}

/**
 * A monotonic clock advancing one second per call, so messages created in
 * sequence get strictly increasing timestamps (for thread/listing ordering).
 */
function tickingClock(startIso = '2026-03-15T12:00:00.000Z'): () => Date {
  let ms = new Date(startIso).getTime();
  return () => {
    const now = new Date(ms);
    ms += 1000;
    return now;
  };
}

/** Build a service wired to fresh in-memory fakes plus all optional ports. */
function makeService(now: () => Date = fixedClock()) {
  const channels = new InMemoryChannelStore(now);
  const orgByChannel = new Map<string, string>();
  const messages = new InMemoryChannelMessageStore((id) => orgByChannel.get(id));
  const audit = new CapturingMessagingAuditRecorder();
  const ingestion = new CapturingIngestionEmitter();
  const delivery = new RecordingRealtimeDelivery();
  const presence = new MapPresenceTracker();
  const notifier = new RecordingNotifier();
  const fileStore = new StubFileStore();
  const assistant = new EchoChatAssistant();
  const service = new MessagingService({
    channels,
    messages,
    audit,
    ingestion,
    delivery,
    presence,
    notifier,
    fileStore,
    assistant,
    idGenerator: sequentialMessagingIdGenerator(),
    now,
  });
  return {
    service,
    channels,
    messages,
    audit,
    ingestion,
    delivery,
    presence,
    notifier,
    fileStore,
    assistant,
    orgByChannel,
  };
}

/** Create a channel via the store directly and register its org for the message store. */
async function seedChannel(
  h: ReturnType<typeof makeService>,
  overrides: Parameters<typeof makeChannel>[0] = {},
): Promise<string> {
  const channel = makeChannel(overrides);
  h.channels.seed(channel.organizationId, channel);
  h.orgByChannel.set(channel.id, channel.organizationId);
  return channel.id;
}

describe('MessagingService.createChannel (Req 27.1)', () => {
  it('persists name, owner, visibility, and members, and audits the creation', async () => {
    const h = makeService();

    const channel = await h.service.createChannel(ctx, {
      name: 'engineering',
      ownerScope: 'team',
      ownerScopeId: 'team-7',
      visibility: 'private',
      members: ['user-2'],
    });

    expect(channel.id).toBe('chan-1');
    expect(channel.name).toBe('engineering');
    expect(channel.ownerScope).toBe('team');
    expect(channel.ownerScopeId).toBe('team-7');
    expect(channel.visibility).toBe('private');
    // The acting user is always added to membership.
    expect(channel.members).toEqual(['user-2', 'user-1']);
    expect(channel.createdAt).toBe('2026-03-15T12:00:00.000Z');

    expect(h.audit.withAction('channel.create')).toHaveLength(1);
    expect(h.audit.last?.event.resourceType).toBe('channel');
    expect(h.audit.last?.event.resourceId).toBe('chan-1');
  });

  it('defaults visibility to public and seeds membership with the creator', async () => {
    const h = makeService();
    const channel = await h.service.createChannel(ctx, {
      name: 'general',
      ownerScope: 'project',
      ownerScopeId: 'proj-1',
    });
    expect(channel.visibility).toBe('public');
    expect(channel.members).toEqual(['user-1']);
  });
});

describe('MessagingService.listChannels (Req 27.8)', () => {
  it('returns public channels and only the private channels the user belongs to', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'pub', visibility: 'public', members: ['user-2'] });
    await seedChannel(h, { id: 'priv-in', visibility: 'private', members: ['user-1'] });
    await seedChannel(h, { id: 'priv-out', visibility: 'private', members: ['user-2'] });

    const listed = await h.service.listChannels(ctx);
    expect(listed.map((c) => c.id).sort()).toEqual(['priv-in', 'pub']);
  });

  it('does not include another organization channels', async () => {
    const h = makeService();
    h.channels.seed('org-2', makeChannel({ id: 'foreign', organizationId: 'org-2' }));
    expect(await h.service.listChannels(ctx)).toEqual([]);
  });
});

describe('MessagingService.post (Req 27.2, 27.9)', () => {
  it('persists the message, delivers it to other members, and emits it for ingestion', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', members: ['user-1', 'user-2', 'user-3'] });

    const message = await h.service.post(ctx, 'c1', { body: 'hello team' });

    expect(message.id).toBe('msg-1');
    expect(message.channelId).toBe('c1');
    expect(message.authorId).toBe('user-1');
    expect(message.body).toBe('hello team');

    const stored = await h.messages.listByChannel(ctx, 'c1');
    expect(stored.map((m) => m.id)).toEqual(['msg-1']);

    // Real-time delivery to the other members (Req 27.2).
    expect(h.delivery.last?.message.id).toBe('msg-1');
    expect(h.delivery.last?.recipientIds.sort()).toEqual(['user-2', 'user-3']);

    // Ingestion-on-write fired with the message content (Req 27.9).
    expect(h.ingestion.count).toBe(1);
    expect(h.ingestion.last?.item.messageId).toBe('msg-1');
    expect(h.ingestion.last?.item.body).toBe('hello team');
  });

  it('raises ChannelNotFoundError for a missing channel and does not emit', async () => {
    const h = makeService();
    await expect(h.service.post(ctx, 'nope', { body: 'x' })).rejects.toBeInstanceOf(
      ChannelNotFoundError,
    );
    expect(h.ingestion.count).toBe(0);
  });
});

describe('MessagingService.reply (Req 27.3)', () => {
  it('associates the reply with the parent and maintains thread order', async () => {
    const h = makeService(tickingClock());
    await seedChannel(h, { id: 'c1', members: ['user-1', 'user-2'] });

    const parent = await h.service.post(ctx, 'c1', { body: 'root' });
    const r1 = await h.service.reply(ctx, parent.id, { body: 'first reply' });
    const r2 = await h.service.reply(ctx, parent.id, { body: 'second reply' });

    expect(r1.parentId).toBe(parent.id);
    expect(r2.parentId).toBe(parent.id);

    const thread = await h.service.listThread(ctx, parent.id);
    expect(thread.map((m) => m.id)).toEqual([r1.id, r2.id]);
    expect(thread.map((m) => m.body)).toEqual(['first reply', 'second reply']);
  });

  it('raises ChannelMessageNotFoundError when the parent does not exist', async () => {
    const h = makeService();
    await expect(h.service.reply(ctx, 'no-parent', { body: 'x' })).rejects.toBeInstanceOf(
      ChannelMessageNotFoundError,
    );
  });
});

describe('MessagingService.listMessages (Req 27.2, 27.3)', () => {
  it('returns a channel messages in chronological order', async () => {
    const h = makeService(tickingClock());
    await seedChannel(h, { id: 'c1', members: ['user-1'] });

    await h.service.post(ctx, 'c1', { body: 'one' });
    await h.service.post(ctx, 'c1', { body: 'two' });
    await h.service.post(ctx, 'c1', { body: 'three' });

    const listed = await h.service.listMessages(ctx, 'c1');
    expect(listed.map((m) => m.body)).toEqual(['one', 'two', 'three']);
  });
});

describe('MessagingService inactive-recipient notification (Req 27.4)', () => {
  it('notifies recipients not actively viewing, and skips active viewers and the author', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', members: ['user-1', 'user-2', 'user-3'] });
    // user-2 is actively viewing; user-3 is not.
    h.presence.setViewing('user-2', 'c1');

    const message = await h.service.post(ctx, 'c1', { body: 'ping' });

    const notified = h.notifier.notifiedFor(message.id);
    expect(notified).toEqual(['user-3']);
  });
});

describe('MessagingService.shareFile (Req 27.5)', () => {
  it('stores the file via DMS and attaches the reference to the message', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', members: ['user-1', 'user-2'] });

    const message = await h.service.shareFile(
      ctx,
      'c1',
      { name: 'spec.pdf', contentType: 'application/pdf', sizeBytes: 1024 },
      { body: 'here is the spec' },
    );

    expect(message.fileRef).toBe('dms-file-1');
    expect(h.fileStore.stored).toHaveLength(1);
    expect(h.fileStore.stored[0]?.name).toBe('spec.pdf');
    // The shared message is delivered and indexed like any other post.
    expect(h.delivery.last?.message.id).toBe(message.id);
    expect(h.ingestion.last?.item.messageId).toBe(message.id);
  });

  it('throws when no file store is wired', async () => {
    const channels = new InMemoryChannelStore();
    const orgByChannel = new Map<string, string>([['c1', 'org-1']]);
    channels.seed('org-1', makeChannel({ id: 'c1', members: ['user-1'] }));
    const service = new MessagingService({
      channels,
      messages: new InMemoryChannelMessageStore((id) => orgByChannel.get(id)),
      audit: new CapturingMessagingAuditRecorder(),
      ingestion: new CapturingIngestionEmitter(),
    });
    await expect(
      service.shareFile(ctx, 'c1', { name: 'a', contentType: 'text/plain', sizeBytes: 1 }),
    ).rejects.toThrow(/file store/);
  });
});

describe('MessagingService.search (Req 27.6, 27.8)', () => {
  it('returns relevance-ranked messages only from channels the user can access', async () => {
    const h = makeService(tickingClock());
    await seedChannel(h, { id: 'pub', visibility: 'public', members: ['user-2'] });
    await seedChannel(h, { id: 'priv-in', visibility: 'private', members: ['user-1'] });
    await seedChannel(h, { id: 'priv-out', visibility: 'private', members: ['user-2'] });

    // A message that mentions "budget" twice ranks above one mentioning it once.
    await h.service.post(ctx, 'pub', { body: 'budget budget planning', authorId: 'user-2' });
    await h.service.post(ctx, 'priv-in', { body: 'the budget is set' });
    // This one is in a private channel the user is NOT a member of: excluded.
    await h.service.post(ctx, 'priv-out', { body: 'secret budget numbers', authorId: 'user-2' });

    const hits = await h.service.search(ctx, 'budget');

    expect(hits.map((hit) => hit.message.channelId)).toEqual(['pub', 'priv-in']);
    expect(hits[0]?.score).toBe(2);
    expect(hits[1]?.score).toBe(1);
  });

  it('returns nothing for a blank query', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', members: ['user-1'] });
    await h.service.post(ctx, 'c1', { body: 'something' });
    expect(await h.service.search(ctx, '   ')).toEqual([]);
  });
});

describe('MessagingService.aiAssist (Req 27.7)', () => {
  it('invokes the Chat_Service and posts the AI response in the channel', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', members: ['user-1'] });

    const reply = await h.service.aiAssist(ctx, 'c1', 'summarize the thread');

    expect(h.assistant.calls).toHaveLength(1);
    expect(h.assistant.calls[0]?.prompt).toBe('summarize the thread');
    expect(reply.authorId).toBe('assistant');
    expect(reply.body).toBe('AI: summarize the thread');

    // The AI response is persisted in the channel and indexed.
    const listed = await h.service.listMessages(ctx, 'c1');
    expect(listed.map((m) => m.id)).toContain(reply.id);
    expect(h.ingestion.last?.item.messageId).toBe(reply.id);
  });
});

describe('MessagingService private-channel access restriction (Req 27.8)', () => {
  it('denies a non-member posting to a private channel and audits the denial', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', visibility: 'private', members: ['user-2'] });

    await expect(
      h.service.post(ctx, 'c1', { body: 'let me in' }),
    ).rejects.toBeInstanceOf(ChannelAccessDeniedError);

    // No message was persisted or indexed.
    expect(h.ingestion.count).toBe(0);
    // The denial was recorded in the audit trail (Req 37.2).
    const denials = h.audit.withAction('channel.post.denied');
    expect(denials).toHaveLength(1);
    expect(denials[0]?.event.resourceId).toBe('c1');
    expect(denials[0]?.event.actorId).toBe('user-1');
  });

  it('denies a non-member reading a private channel and audits the denial', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', visibility: 'private', members: ['user-2'] });

    await expect(h.service.listMessages(ctx, 'c1')).rejects.toBeInstanceOf(
      ChannelAccessDeniedError,
    );
    expect(h.audit.withAction('channel.read.denied')).toHaveLength(1);
  });

  it('allows a member to post to a private channel', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', visibility: 'private', members: ['user-1'] });
    const message = await h.service.post(ctx, 'c1', { body: 'members only' });
    expect(message.body).toBe('members only');
    expect(h.audit.withAction('channel.post.denied')).toHaveLength(0);
  });

  it('allows anyone in the org to post to a public channel', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', visibility: 'public', members: ['user-2'] });
    const message = await h.service.post(ctx, 'c1', { body: 'open to all' });
    expect(message.body).toBe('open to all');
  });
});

describe('MessagingService.addMember (Req 27.1)', () => {
  it('adds a member, audits it, and grants subsequent access', async () => {
    const h = makeService();
    await seedChannel(h, { id: 'c1', visibility: 'private', members: ['user-2'] });

    const updated = await h.service.addMember(ctx, 'c1', 'user-1');
    expect(updated.members).toContain('user-1');
    expect(h.audit.withAction('channel.add_member')).toHaveLength(1);

    // user-1 can now post.
    await expect(h.service.post(ctx, 'c1', { body: 'now a member' })).resolves.toMatchObject({
      body: 'now a member',
    });
  });
});

describe('MessagingService tenant scoping (Req 1.2)', () => {
  it('cannot find a channel owned by another organization', async () => {
    const h = makeService();
    h.channels.seed('org-2', makeChannel({ id: 'c1', organizationId: 'org-2' }));
    h.orgByChannel.set('c1', 'org-2');

    await expect(h.service.post(ctx, 'c1', { body: 'x' })).rejects.toBeInstanceOf(
      ChannelNotFoundError,
    );
    // The owning org can post.
    await expect(
      h.service.post(otherOrgCtx, 'c1', { body: 'ok' }),
    ).resolves.toMatchObject({ body: 'ok' });
  });
});
