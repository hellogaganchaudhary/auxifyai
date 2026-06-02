/**
 * Test fakes and builders for the Messaging_Service (Req 27.1-27.9).
 *
 * The service composes a {@link ChannelStore}, a {@link ChannelMessageStore},
 * the shared {@link AuditRecorder}, and the {@link MessageIngestionEmitter}, plus
 * the optional delivery/presence/notifier/file-store/assistant ports. These
 * in-memory fakes let unit and property tests drive the service deterministically
 * and inspect what was persisted, delivered, notified, audited, and emitted for
 * ingestion — without a database, WebSocket transport, DMS, or AI provider:
 *
 *   - {@link InMemoryChannelStore} / {@link InMemoryChannelMessageStore} model
 *     the tenant-scoped repositories' observable behaviour (org scoping,
 *     chronological message ordering, thread ordering, membership updates).
 *   - {@link CapturingMessagingAuditRecorder} records every `(ctx, event)` so a
 *     test can assert exactly which mutations and denials were audited.
 *   - {@link CapturingIngestionEmitter} records every emitted item so a test can
 *     assert ingestion-on-write fired (Req 27.9).
 *   - {@link RecordingRealtimeDelivery}, {@link RecordingNotifier},
 *     {@link MapPresenceTracker}, {@link StubFileStore}, and
 *     {@link EchoChatAssistant} are small doubles for the optional ports.
 *   - {@link makeChannel} / {@link makeChannelMessage} / {@link sequentialMessagingIdGenerator}
 *     are builders with sensible defaults.
 *
 * The fakes are exported (not test-only) so a concurrent property test can reuse
 * exactly the same doubles.
 */

import type { TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type { MessagingIdGenerator } from './messaging-service.js';
import type {
  MessageNotifier,
  MessagingChatAssistant,
  MessagingFileStore,
  MessagingUploadedFile,
  PresenceTracker,
  RealtimeDelivery,
} from './messaging-service.js';
import type {
  Channel,
  ChannelMessage,
  ChannelMessageStore,
  ChannelStore,
  CreateChannelInput,
  CreateChannelMessageInput,
  MessageIngestionEmitter,
  MessageIngestionItem,
  MessageListOptions,
} from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedMessagingAudit {
  /** The tenant context the event was recorded under. */
  ctx: TenantContext;
  /** The recorded audit event. */
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which mutations and denied accesses were audited (Req 27.8, 37.1).
 */
export class CapturingMessagingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedMessagingAudit[] = [];

  async record(ctx: TenantContext, event: AuditEvent): Promise<void> {
    this.recorded.push({
      ctx: { ...ctx },
      event: { ...event, metadata: { ...(event.metadata ?? {}) } },
    });
  }

  /** The number of events recorded so far. */
  get count(): number {
    return this.recorded.length;
  }

  /** Every recorded event with the given action (e.g. `channel.create`). */
  withAction(action: string): CapturedMessagingAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedMessagingAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/**
 * A capturing {@link MessageIngestionEmitter} storing every emitted item so a
 * test can assert ingestion-on-write fired for each created message (Req 27.9).
 */
export class CapturingIngestionEmitter implements MessageIngestionEmitter {
  /** Every emitted item, in order, with the context it was scoped to. */
  readonly emitted: { ctx: TenantContext; item: MessageIngestionItem }[] = [];

  async emit(ctx: TenantContext, item: MessageIngestionItem): Promise<void> {
    this.emitted.push({ ctx: { ...ctx }, item: { ...item } });
  }

  /** The number of items emitted so far. */
  get count(): number {
    return this.emitted.length;
  }

  /** The single most recently emitted item, or `undefined` if none. */
  get last(): { ctx: TenantContext; item: MessageIngestionItem } | undefined {
    return this.emitted[this.emitted.length - 1];
  }
}

/** A captured real-time delivery, for assertions (Req 27.2). */
export interface CapturedDelivery {
  /** The delivered message. */
  message: ChannelMessage;
  /** The recipient user ids the message was delivered to. */
  recipientIds: string[];
}

/**
 * A {@link RealtimeDelivery} fake recording every delivery so a test can assert
 * a posted message was delivered to the authorized recipients (Req 27.2).
 */
export class RecordingRealtimeDelivery implements RealtimeDelivery {
  /** Every delivery, in order. */
  readonly deliveries: CapturedDelivery[] = [];

  async deliver(
    _ctx: TenantContext,
    message: ChannelMessage,
    recipientIds: string[],
  ): Promise<void> {
    this.deliveries.push({ message: { ...message }, recipientIds: [...recipientIds] });
  }

  /** The single most recent delivery, or `undefined` if none. */
  get last(): CapturedDelivery | undefined {
    return this.deliveries[this.deliveries.length - 1];
  }
}

/**
 * A {@link MessageNotifier} fake recording every generated notification so a
 * test can assert inactive recipients were notified (Req 27.4).
 */
export class RecordingNotifier implements MessageNotifier {
  /** Every generated notification, in order. */
  readonly notifications: { userId: string; channelId: string; messageId: string }[] = [];

  async notify(
    _ctx: TenantContext,
    input: { userId: string; channelId: string; messageId: string },
  ): Promise<void> {
    this.notifications.push({ ...input });
  }

  /** The user ids notified for a given message id. */
  notifiedFor(messageId: string): string[] {
    return this.notifications.filter((n) => n.messageId === messageId).map((n) => n.userId);
  }
}

/**
 * A {@link PresenceTracker} fake backed by an explicit set of `userId|channelId`
 * pairs that are "actively viewing" (Req 27.4). Anything not marked is inactive.
 */
export class MapPresenceTracker implements PresenceTracker {
  private readonly viewing = new Set<string>();

  /** Mark `userId` as actively viewing `channelId`. */
  setViewing(userId: string, channelId: string): this {
    this.viewing.add(`${userId}|${channelId}`);
    return this;
  }

  isViewing(userId: string, channelId: string): boolean {
    return this.viewing.has(`${userId}|${channelId}`);
  }
}

/**
 * A {@link MessagingFileStore} fake returning a deterministic, sequential
 * reference per stored file (Req 27.5).
 */
export class StubFileStore implements MessagingFileStore {
  /** Every file stored, in order. */
  readonly stored: MessagingUploadedFile[] = [];
  private seq = 0;

  async store(_ctx: TenantContext, file: MessagingUploadedFile): Promise<{ ref: string }> {
    this.stored.push({ ...file });
    this.seq += 1;
    return { ref: `dms-file-${this.seq}` };
  }
}

/**
 * A {@link MessagingChatAssistant} fake echoing the prompt as the assistant
 * reply body (Req 27.7), so tests can assert the AI response was posted.
 */
export class EchoChatAssistant implements MessagingChatAssistant {
  /** Every assist request, in order. */
  readonly calls: { channelId: string; prompt: string }[] = [];

  async assist(
    _ctx: TenantContext,
    input: { channelId: string; prompt: string },
  ): Promise<string> {
    this.calls.push({ ...input });
    return `AI: ${input.prompt}`;
  }
}

/** Clone a channel row so callers can never mutate stored state. */
function cloneChannel(channel: Channel): Channel {
  return { ...channel, members: [...channel.members] };
}

/**
 * An in-memory {@link ChannelStore} modelling the tenant-scoped channel
 * repository: rows are confined to their Organization and membership updates are
 * applied in place.
 */
export class InMemoryChannelStore implements ChannelStore {
  private readonly rows = new Map<string, { organizationId: string; record: Channel }>();
  private clock: () => Date;

  /** @param now Injected clock so `createdAt` is deterministic in tests. */
  constructor(now: () => Date = () => new Date()) {
    this.clock = now;
  }

  /** Seed a fully-formed channel (e.g. another tenant's, or with fixed timestamps). */
  seed(organizationId: string, record: Channel): void {
    this.rows.set(record.id, { organizationId, record: cloneChannel(record) });
  }

  async create(ctx: TenantContext, input: CreateChannelInput): Promise<Channel> {
    const record: Channel = {
      id: input.id,
      organizationId: ctx.organizationId,
      ownerScope: input.ownerScope,
      ownerScopeId: input.ownerScopeId,
      name: input.name,
      visibility: input.visibility,
      members: [...input.members],
      createdAt: this.clock().toISOString(),
    };
    this.rows.set(record.id, { organizationId: ctx.organizationId, record });
    return cloneChannel(record);
  }

  async findById(ctx: TenantContext, id: string): Promise<Channel | null> {
    const entry = this.rows.get(id);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) return null;
    return cloneChannel(entry.record);
  }

  async list(ctx: TenantContext): Promise<Channel[]> {
    return [...this.rows.values()]
      .filter((entry) => entry.organizationId === ctx.organizationId)
      .map((entry) => cloneChannel(entry.record));
  }

  async setMembers(ctx: TenantContext, id: string, members: string[]): Promise<Channel | null> {
    const entry = this.rows.get(id);
    if (entry === undefined || entry.organizationId !== ctx.organizationId) return null;
    entry.record.members = [...members];
    return cloneChannel(entry.record);
  }
}

/** Clone a message row so stored state is immutable. */
function cloneMessage(message: ChannelMessage): ChannelMessage {
  return { ...message };
}

/**
 * An in-memory {@link ChannelMessageStore} modelling the tenant-scoped message
 * repository: messages are scoped through their parent channel's Organization,
 * listed chronologically, and threaded replies are ordered by creation time
 * (Req 27.3).
 */
export class InMemoryChannelMessageStore implements ChannelMessageStore {
  private readonly rows = new Map<string, ChannelMessage>();
  private seq = 0;

  /**
   * @param channelOrg Resolves a channel id to its owning Organization,
   *   modelling the parent-tenant scope. A channel not in the map (or in a
   *   different org) yields no rows for that tenant.
   */
  constructor(private readonly channelOrg: (channelId: string) => string | undefined) {}

  /** Seed a message row directly (e.g. for search/listing tests). */
  seed(record: ChannelMessage): void {
    this.rows.set(record.id, cloneMessage(record));
  }

  async create(ctx: TenantContext, input: CreateChannelMessageInput): Promise<ChannelMessage> {
    this.seq += 1;
    const message: ChannelMessage = {
      id: input.id,
      channelId: input.channelId,
      authorId: input.authorId,
      body: input.body,
      createdAt:
        input.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, 0, this.seq)).toISOString(),
      ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      ...(input.fileRef !== undefined ? { fileRef: input.fileRef } : {}),
    };
    // Tenant guard: refuse a message whose channel is not in the caller's org.
    if (this.channelOrg(message.channelId) !== ctx.organizationId) {
      throw new Error(
        `InMemoryChannelMessageStore: channel "${message.channelId}" not in organization "${ctx.organizationId}"`,
      );
    }
    this.rows.set(message.id, message);
    return cloneMessage(message);
  }

  async findById(ctx: TenantContext, id: string): Promise<ChannelMessage | null> {
    const row = this.rows.get(id);
    if (row === undefined || this.channelOrg(row.channelId) !== ctx.organizationId) return null;
    return cloneMessage(row);
  }

  async listByChannel(
    ctx: TenantContext,
    channelId: string,
    options: MessageListOptions = {},
  ): Promise<ChannelMessage[]> {
    if (this.channelOrg(channelId) !== ctx.organizationId) return [];
    let rows = [...this.rows.values()]
      .filter((r) => r.channelId === channelId)
      .sort(compareChronological);
    if (options.offset !== undefined) rows = rows.slice(options.offset);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map(cloneMessage);
  }

  async listReplies(
    ctx: TenantContext,
    parentId: string,
    options: MessageListOptions = {},
  ): Promise<ChannelMessage[]> {
    const parent = this.rows.get(parentId);
    if (parent === undefined || this.channelOrg(parent.channelId) !== ctx.organizationId) {
      return [];
    }
    let rows = [...this.rows.values()]
      .filter((r) => r.parentId === parentId)
      .sort(compareChronological);
    if (options.offset !== undefined) rows = rows.slice(options.offset);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map(cloneMessage);
  }
}

/** Chronological comparator (createdAt asc, then id asc) for a total order. */
function compareChronological(a: ChannelMessage, b: ChannelMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Build a {@link Channel} with sensible defaults; override field-by-field. */
export function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'chan-1',
    organizationId: 'org-1',
    ownerScope: 'project',
    ownerScopeId: 'proj-1',
    name: 'general',
    visibility: 'public',
    members: ['user-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a {@link ChannelMessage} with sensible defaults; override field-by-field. */
export function makeChannelMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: 'msg-1',
    channelId: 'chan-1',
    authorId: 'user-1',
    body: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A deterministic {@link MessagingIdGenerator} handing out `chan-1`, `chan-2`, …
 * channel ids and `msg-1`, `msg-2`, … message ids, for assertion-friendly tests.
 */
export function sequentialMessagingIdGenerator(): MessagingIdGenerator {
  let channelCounter = 0;
  let messageCounter = 0;
  return {
    channelId: () => `chan-${(channelCounter += 1)}`,
    messageId: () => `msg-${(messageCounter += 1)}`,
  };
}
