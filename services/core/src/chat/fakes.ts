/**
 * Test fakes and builders for the Chat_Service.
 *
 * The Chat_Service composes four injected ports — a {@link RoutingPort}
 * (the Model_Router), a {@link ChatConversationStore} and a
 * {@link ChatMessageStore} (the tenant-scoped repositories), and a
 * {@link TitleGenerator}. These in-memory fakes let unit and property tests
 * (task 8.4, Property 15) drive the service deterministically — with no real
 * providers, network, or database — and inspect what was routed, persisted, and
 * titled:
 *
 *   - {@link FakeRoutingPort} returns a canned {@link RoutedChatResult} (fixed or
 *     computed from the request) and records every `(req, principal)` so a test
 *     can assert the effective model routed and that prior history was sent.
 *   - {@link InMemoryChatConversationStore} / {@link InMemoryChatMessageStore}
 *     model the repositories' observable behaviour (org scoping, chronological
 *     message listing, active-model/title updates) closely enough to exercise the
 *     service's logic, and expose snapshots so a test can prove prior messages are
 *     never rewritten by a model switch (Req 3.10 / Property 15).
 *   - {@link FakeTitleGenerator} returns a canned (or computed) title and records
 *     every call so a test can assert auto-titling happened only on the first
 *     untitled exchange (Req 5.8).
 *   - {@link makeRoutedResult} builds a {@link RoutedChatResult} with sensible
 *     defaults; {@link makePrincipal} / {@link makeModel} are re-exported from the
 *     router fakes so the Chat_Service is tested against the same doubles.
 */

import type {
  ChatChunk,
  ChatRequest,
  ModelInfo,
  Principal,
  TenantContext,
  TokenUsage,
} from '@auxify/types';

import type {
  ConversationRecord,
  CreateConversationInput,
  CreateMessageInput,
  ListOptions,
  MessageRecord,
  UpdateConversationInput,
  UpdateMessageInput,
} from '../repositories/index.js';
import { computeCost, type RequestOutcome, type RoutedChatResult } from '../router/index.js';

import type { TitleGenerator, TitleSource } from './title-generator.js';
import type { ChatConversationStore, ChatMessageStore, RoutingPort } from './types.js';

export { makeModel, makePrincipal } from '../router/fakes.js';

/**
 * Build a {@link RoutedChatResult} with sensible defaults for the served model
 * and usage, deriving the recorded {@link RequestOutcome} (including cost via the
 * router's {@link computeCost}) so a test gets a self-consistent canned result.
 *
 * @param model The model that served the request.
 * @param overrides Optional usage/latency/text/decision/finishReason overrides.
 */
export function makeRoutedResult(
  model: ModelInfo,
  overrides: {
    usage?: TokenUsage;
    latencyMs?: number;
    text?: string;
    mode?: 'explicit' | 'auto';
    finishReason?: RoutedChatResult['finishReason'];
  } = {},
): RoutedChatResult {
  const usage = overrides.usage ?? { inputTokens: 10, outputTokens: 20 };
  const latencyMs = overrides.latencyMs ?? 42;
  const text = overrides.text ?? 'assistant reply';
  const mode = overrides.mode ?? 'explicit';
  const finishReason = overrides.finishReason ?? 'stop';

  const chunks: ChatChunk[] = [
    { delta: text },
    { delta: '', done: true, model: model.id, finishReason, usage },
  ];
  const outcome: RequestOutcome = {
    modelId: model.id,
    mode,
    latencyMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cost: computeCost(model, usage),
    failedAttempts: [],
  };
  return {
    decision: { model, mode, reason: `fake: routed to "${model.id}"` },
    outcome,
    usage,
    finishReason,
    chunks,
  };
}

/** A captured `route` invocation as seen by the {@link RoutingPort}. */
export interface CapturedRoute {
  req: ChatRequest;
  principal: Principal;
}

/**
 * A {@link RoutingPort} that returns a canned {@link RoutedChatResult}.
 *
 * Construct with a fixed result or a function computing one from the
 * `(req, principal)` — e.g. to echo the requested model id back through the
 * outcome so a test can assert the effective model that was routed (Req 3.10).
 * Every call is captured in {@link calls}.
 */
export class FakeRoutingPort implements RoutingPort {
  /** Every `route` invocation, in order. */
  readonly calls: CapturedRoute[] = [];

  constructor(
    private readonly decide:
      | RoutedChatResult
      | ((req: ChatRequest, principal: Principal) => RoutedChatResult),
  ) {}

  async route(req: ChatRequest, principal: Principal): Promise<RoutedChatResult> {
    this.calls.push({ req, principal });
    return typeof this.decide === 'function' ? this.decide(req, principal) : this.decide;
  }

  /** The most recent routed request, or `undefined` when none. */
  get lastRequest(): ChatRequest | undefined {
    return this.calls[this.calls.length - 1]?.req;
  }
}

/** Clone a conversation row so callers can never mutate stored state. */
function cloneConversation(record: ConversationRecord): ConversationRecord {
  return { ...record };
}

/**
 * An in-memory {@link ChatConversationStore} modelling the tenant-scoped
 * `ConversationRepository`: rows are confined to their Organization, and updates
 * bump `updatedAt`.
 */
export class InMemoryChatConversationStore implements ChatConversationStore {
  private readonly rows = new Map<string, ConversationRecord>();
  private clock: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.clock = now;
  }

  /** Seed a fully-formed row (e.g. fixed timestamps, a pre-set title/active model). */
  seed(record: ConversationRecord): void {
    this.rows.set(record.id, cloneConversation(record));
  }

  /** Create a conversation row in the caller's Organization (test helper). */
  create(ctx: TenantContext, input: CreateConversationInput): ConversationRecord {
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
    row.updatedAt = this.clock().toISOString();
    return cloneConversation(row);
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
 * An in-memory {@link ChatMessageStore} modelling the tenant-scoped
 * `MessageRepository`: messages are scoped through their parent conversation's
 * Organization and listed chronologically. Each `create` assigns a strictly
 * increasing `createdAt` so insertion order is the chronological order, letting
 * tests reason about "the first exchange" deterministically (Req 5.8).
 */
export class InMemoryChatMessageStore implements ChatMessageStore {
  private readonly rows = new Map<string, MessageRecord>();
  private sequence = 0;

  /**
   * @param conversationOrg Resolves a conversation id to its owning
   *   Organization, modelling the parent-tenant scope. A conversation not in the
   *   map (or in a different org) yields no rows for that tenant.
   */
  constructor(private readonly conversationOrg: (conversationId: string) => string | undefined) {}

  /** A strictly-increasing ISO timestamp so insertion order == chronological order. */
  private nextTimestamp(): string {
    this.sequence += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + this.sequence).toISOString();
  }

  async create(ctx: TenantContext, input: CreateMessageInput): Promise<MessageRecord> {
    if (this.conversationOrg(input.conversationId) !== ctx.organizationId) {
      throw new Error(
        `cross-tenant message create: conversation "${input.conversationId}" is not in org "${ctx.organizationId}"`,
      );
    }
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
      createdAt: this.nextTimestamp(),
    };
    this.rows.set(record.id, cloneMessage(record));
    return cloneMessage(record);
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

  /** Fetch a message by id, tenant-scoped through its parent conversation. */
  async findById(ctx: TenantContext, id: string): Promise<MessageRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    if (this.conversationOrg(row.conversationId) !== ctx.organizationId) return null;
    return cloneMessage(row);
  }

  /** Update a message's rating/pinned state, tenant-scoped, or `null` if absent. */
  async update(
    ctx: TenantContext,
    id: string,
    input: UpdateMessageInput,
  ): Promise<MessageRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined) return null;
    if (this.conversationOrg(row.conversationId) !== ctx.organizationId) return null;
    if (input.rating !== undefined) row.rating = input.rating;
    if (input.pinned !== undefined) row.pinned = input.pinned;
    this.rows.set(id, row);
    return cloneMessage(row);
  }

  /** A defensive snapshot of every stored message, in chronological order. */
  snapshot(): MessageRecord[] {
    return [...this.rows.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map(cloneMessage);
  }
}

/** A captured title-generation invocation. */
export interface CapturedTitleCall {
  source: TitleSource;
  principal: Principal;
}

/**
 * A {@link TitleGenerator} that returns a canned (or computed) title and records
 * every call, so a test can assert auto-titling ran only on the first untitled
 * exchange and never overwrote a user title (Req 5.8).
 */
export class FakeTitleGenerator implements TitleGenerator {
  /** Every `generate` invocation, in order. */
  readonly calls: CapturedTitleCall[] = [];

  constructor(
    private readonly decide: string | ((source: TitleSource) => string) = 'Generated title',
  ) {}

  async generate(source: TitleSource, principal: Principal): Promise<string> {
    this.calls.push({ source, principal });
    return typeof this.decide === 'function' ? this.decide(source) : this.decide;
  }

  /** The number of times a title was generated. */
  get count(): number {
    return this.calls.length;
  }
}

/**
 * A deterministic message-id generator handing out `msg-1`, `msg-2`, … for
 * assertion-friendly tests.
 */
export function sequentialMessageIdGenerator(): () => string {
  let counter = 0;
  return () => `msg-${(counter += 1)}`;
}
