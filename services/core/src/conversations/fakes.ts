/**
 * Test fakes and builders for the Conversation_Manager.
 *
 * The manager composes three injected ports — a {@link ConversationStore}, a
 * {@link MessageStore}, and an {@link AuditRecorder}. These in-memory fakes let
 * unit and property tests drive the manager deterministically and inspect what
 * was persisted and audited, without a database:
 *
 *   - {@link InMemoryConversationStore} / {@link InMemoryMessageStore} model the
 *     tenant-scoped repositories' observable behaviour (org scoping, owner
 *     listing ordered `updatedAt` DESC, update bumping `updatedAt`, parent-tenant
 *     scoping for messages) closely enough to exercise the manager's logic.
 *   - {@link CapturingAuditRecorder} records every `(ctx, event)` so a test can
 *     assert exactly which mutations were audited (Req 5.3).
 *   - {@link makeConversationRecord} / {@link makeMessageRecord} /
 *     {@link sequentialIdGenerator} are small builders with sensible defaults.
 *
 * The fakes are exported (not test-only) so the concurrent property test
 * (task 8.2, Property 17) reuses exactly the same doubles.
 */

import type { ContentBlock, TenantContext } from '@auxify/types';

import type { AuditEvent, AuditRecorder } from '../audit/index.js';
import type {
  ConversationRecord,
  CreateConversationInput,
  CreateMessageInput,
  ListOptions,
  MessageRecord,
  UpdateConversationInput,
  UpdateMessageInput,
} from '../repositories/index.js';
import type { ConversationIdGenerator } from './conversation-manager.js';
import type { ConversationStore, MessageStore } from './types.js';

/** A captured `(ctx, event)` pair as seen by the {@link AuditRecorder} port. */
export interface CapturedAudit {
  ctx: TenantContext;
  event: AuditEvent;
}

/**
 * A capturing {@link AuditRecorder} storing every recorded event so tests can
 * assert which mutations were audited (Req 5.3).
 */
export class CapturingAuditRecorder implements AuditRecorder {
  /** Every recorded event, in order, with the context it was scoped to. */
  readonly recorded: CapturedAudit[] = [];

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

  /** Every recorded event with the given action (e.g. `conversation.rename`). */
  withAction(action: string): CapturedAudit[] {
    return this.recorded.filter((r) => r.event.action === action);
  }

  /** The single most recently recorded event, or `undefined` if none. */
  get last(): CapturedAudit | undefined {
    return this.recorded[this.recorded.length - 1];
  }
}

/** Clone a conversation row so callers can never mutate stored state. */
function cloneConversation(record: ConversationRecord): ConversationRecord {
  return { ...record };
}

/**
 * An in-memory {@link ConversationStore} modelling the tenant-scoped
 * `ConversationRepository`: rows are confined to their Organization, owner
 * listings are ordered most-recent-update first, and updates bump `updatedAt`.
 */
export class InMemoryConversationStore implements ConversationStore {
  private readonly rows = new Map<string, ConversationRecord>();
  private clock: () => Date;

  /** @param now Injected clock so `updatedAt` bumps are deterministic in tests. */
  constructor(now: () => Date = () => new Date()) {
    this.clock = now;
  }

  /** Override the clock (e.g. to advance time between updates in a test). */
  setClock(now: () => Date): void {
    this.clock = now;
  }

  /** Seed a fully-formed row (e.g. another tenant's data, or fixed timestamps). */
  seed(record: ConversationRecord): void {
    this.rows.set(record.id, cloneConversation(record));
  }

  async create(ctx: TenantContext, input: CreateConversationInput): Promise<ConversationRecord> {
    const ts = this.clock().toISOString();
    const record: ConversationRecord = {
      id: input.id,
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      title: input.title ?? '',
      folderId: input.folderId ?? null,
      archived: input.archived ?? false,
      shareToken: input.shareToken ?? null,
      shareMode: input.shareMode ?? null,
      personaId: input.personaId ?? null,
      activeModelId: input.activeModelId ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(record.id, record);
    return cloneConversation(record);
  }

  async findById(ctx: TenantContext, id: string): Promise<ConversationRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    return cloneConversation(row);
  }

  async listByOwner(
    ctx: TenantContext,
    ownerId: string,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<ConversationRecord[]> {
    let rows = [...this.rows.values()]
      .filter((r) => r.organizationId === ctx.organizationId && r.ownerId === ownerId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    if (options.offset !== undefined) rows = rows.slice(options.offset);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map(cloneConversation);
  }

  async list(
    ctx: TenantContext,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<ConversationRecord[]> {
    let rows = [...this.rows.values()]
      .filter((r) => r.organizationId === ctx.organizationId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    if (options.offset !== undefined) rows = rows.slice(options.offset);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map(cloneConversation);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return null;
    if (input.title !== undefined) row.title = input.title;
    if (input.folderId !== undefined) row.folderId = input.folderId;
    if (input.archived !== undefined) row.archived = input.archived;
    if (input.shareToken !== undefined) row.shareToken = input.shareToken;
    if (input.shareMode !== undefined) row.shareMode = input.shareMode;
    if (input.personaId !== undefined) row.personaId = input.personaId;
    if (input.activeModelId !== undefined) row.activeModelId = input.activeModelId;
    // Mirror the repository: every mutation bumps the update timestamp (Req 5.2).
    row.updatedAt = this.clock().toISOString();
    return cloneConversation(row);
  }

  async delete(ctx: TenantContext, id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (row === undefined || row.organizationId !== ctx.organizationId) return false;
    this.rows.delete(id);
    return true;
  }
}

/** Clone a message row (with its content/attachments) so stored state is immutable. */
function cloneMessage(record: MessageRecord): MessageRecord {
  return {
    ...record,
    content: record.content.map((block) => ({ ...block })),
    attachments: [...record.attachments],
  };
}

/**
 * An in-memory {@link MessageStore} modelling the tenant-scoped
 * `MessageRepository`: messages are scoped through their parent conversation's
 * Organization, listed chronologically, and updatable for rating/pinning.
 */
export class InMemoryMessageStore implements MessageStore {
  private readonly rows = new Map<string, MessageRecord>();

  /**
   * @param conversationOrg Resolves a conversation id to its owning
   *   Organization, modelling the parent-tenant scope. A conversation not in the
   *   map (or in a different org) yields no rows for that tenant.
   */
  constructor(private readonly conversationOrg: (conversationId: string) => string | undefined) {}

  /** Seed a message row directly. */
  seed(record: MessageRecord): void {
    this.rows.set(record.id, cloneMessage(record));
  }

  /** Create a message row (test helper; the manager itself does not create messages). */
  create(input: CreateMessageInput & { createdAt?: string }): MessageRecord {
    const record: MessageRecord = {
      id: input.id,
      conversationId: input.conversationId,
      parentId: input.parentId ?? null,
      role: input.role,
      content: input.content ?? [],
      model: input.model ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      cost: input.cost ?? null,
      latencyMs: input.latencyMs ?? null,
      rating: input.rating ?? null,
      pinned: input.pinned ?? false,
      attachments: input.attachments ?? [],
      createdAt: input.createdAt ?? new Date('2026-01-01T00:00:00.000Z').toISOString(),
    };
    this.rows.set(record.id, cloneMessage(record));
    return cloneMessage(record);
  }

  /** Whether a message belongs to a conversation in the caller's Organization. */
  private inTenant(ctx: TenantContext, record: MessageRecord): boolean {
    return this.conversationOrg(record.conversationId) === ctx.organizationId;
  }

  async findById(ctx: TenantContext, id: string): Promise<MessageRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return null;
    return cloneMessage(row);
  }

  async listByConversation(
    ctx: TenantContext,
    conversationId: string,
    options: Pick<ListOptions, 'limit' | 'offset'> = {},
  ): Promise<MessageRecord[]> {
    if (this.conversationOrg(conversationId) !== ctx.organizationId) return [];
    let rows = [...this.rows.values()]
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    if (options.offset !== undefined) rows = rows.slice(options.offset);
    if (options.limit !== undefined) rows = rows.slice(0, options.limit);
    return rows.map(cloneMessage);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateMessageInput,
  ): Promise<MessageRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || !this.inTenant(ctx, row)) return null;
    if (input.rating !== undefined) row.rating = input.rating;
    if (input.pinned !== undefined) row.pinned = input.pinned;
    return cloneMessage(row);
  }
}

/** Build a {@link ConversationRecord} with sensible defaults; override field-by-field. */
export function makeConversationRecord(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: 'conv-1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    ownerId: 'user-1',
    title: '',
    folderId: null,
    archived: false,
    shareToken: null,
    shareMode: null,
    personaId: null,
    activeModelId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Build a {@link MessageRecord} with sensible defaults; override field-by-field. */
export function makeMessageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  const content: ContentBlock[] = overrides.content ?? [{ type: 'markdown', data: { text: '' } }];
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    parentId: null,
    role: 'user',
    model: null,
    inputTokens: null,
    outputTokens: null,
    cost: null,
    latencyMs: null,
    rating: null,
    pinned: false,
    attachments: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
    content,
  };
}

/**
 * A deterministic {@link ConversationIdGenerator} handing out `conv-1`,
 * `conv-2`, … ids and `share-1`, `share-2`, … tokens, for assertion-friendly
 * tests.
 */
export function sequentialIdGenerator(): ConversationIdGenerator {
  let idCounter = 0;
  let tokenCounter = 0;
  return {
    id: () => `conv-${(idCounter += 1)}`,
    shareToken: () => `share-${(tokenCounter += 1)}`,
  };
}
