/**
 * The Chat_Service — send path, mid-conversation model switch, and auto-title
 * generation (Req 3.10, 5.8, and the chat send path of Req 4).
 *
 * This is the orchestrator that turns "the user sent a message" into a fully
 * persisted exchange. For a single {@link ChatService.send} it:
 *
 *   1. resolves the conversation and the **effective model** — the explicitly
 *      requested model, else the conversation's active model, else Auto Mode —
 *      so a prior {@link ChatService.switchModel} governs subsequent sends
 *      without the caller re-specifying the model (Req 3.10);
 *   2. persists the user's message (Req 44.6);
 *   3. routes the conversation so far through the {@link RoutingPort}
 *      (the Model_Router), which selects/falls back/records the outcome (Req 3);
 *   4. persists the assistant's response with the model that served it and the
 *      recorded token counts and cost (Req 3.9, 44.6); and
 *   5. after the **first exchange** of a still-untitled conversation,
 *      auto-generates a title that summarizes it — never overwriting a
 *      user-assigned title (Req 5.8).
 *
 * ## Mid-conversation model switch (Req 3.10)
 *
 * {@link ChatService.switchModel} updates only the conversation's *active
 * model*. Prior messages keep the model recorded on them, and only subsequent
 * sends that do not name a model pick up the new active model. The service never
 * rewrites previously-persisted messages, which is exactly the invariant
 * Property 15 (task 8.4) checks: switching the model preserves history.
 *
 * ## Streaming seam (Req 4.1-4.5)
 *
 * The Model_Router *collects* a provider's chunks (it cannot transparently
 * retry a partially-streamed model), so this service returns the assistant
 * message together with the routed result's {@link ChatSendResult.chunks}, terminal
 * usage, and finish reason. A transport adapter (gateway, task 24.x) relays those
 * chunks to the client incrementally through the {@link import('../streaming/index.js').StreamingEngine},
 * whose {@link import('../streaming/index.js').PartialResponsePersister} hook
 * persists the received prefix on a user cancel (Req 4.4) or client disconnect
 * (Req 4.5). This service owns durable persistence of the *full* exchange; the
 * incremental relay is deliberately left to the Streaming_Engine so fallback and
 * streaming stay cleanly separated. (The persistence-on-cancel hook can be wired
 * to {@link ChatMessageStore.create} by the gateway.)
 *
 * ## Tenant scope
 *
 * Like the Conversation_Manager, every method takes the caller's
 * {@link TenantContext} explicitly (so persistence is confined to the
 * Organization, Req 1.2/1.4); `send`/`generateTitle` additionally take the
 * authenticated {@link Principal} the Model_Router and a model-backed
 * {@link TitleGenerator} need. This refines the design's simplified
 * `send(req, principal)` signature the same way the Conversation_Manager refines
 * its design signatures.
 */

import { randomUUID } from 'node:crypto';

import type { ChatRequest, ContentBlock, Principal, TenantContext } from '@auxify/types';

import { ConversationNotFoundError, MessageNotFoundError } from '../conversations/index.js';
import type { ConversationRecord, MessageRecord } from '../repositories/index.js';
import type { RoutedChatResult } from '../router/index.js';
import { AUTO_MODEL_ID } from '../router/index.js';

import { blocksToText, chunksToText, recordsToChatMessages, toContentBlocks } from './content.js';
import {
  DeterministicTitleGenerator,
  normalizeTitle,
  type TitleGenerator,
  type TitleSource,
} from './title-generator.js';
import type {
  Branch,
  ChatCompareRequest,
  ChatConversationStore,
  ChatMessageStore,
  ChatSendRequest,
  ChatSendResult,
  CompareResult,
  MessageRating,
  RegenerateResult,
  RoutingPort,
} from './types.js';

/** Generates unique message ids (injectable for deterministic tests). */
export type MessageIdGenerator = () => string;

/**
 * Optional routing overrides shared by the re-routing paths
 * (edit/regenerate/compare): a system prompt and sampling controls forwarded to
 * the model request.
 */
interface RouteOverrides {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Options for {@link ChatService.editMessage}: which model to re-route the
 * edited turn through (defaults to the conversation's active model, then Auto
 * Mode), plus optional system-prompt/sampling overrides.
 */
export interface EditMessageOptions extends RouteOverrides {
  /** The model to route the re-generated reply through; defaults to active/Auto. */
  modelId?: string;
}

/**
 * Walk the parent-linked branch tree from `leafId` back to the root, returning
 * the messages on that single path oldest-first.
 *
 * The conversation's message rows form a tree via `parentId`; a model request
 * needs exactly the messages along one branch (the path from the root down to
 * the message we are responding under), not every sibling branch. Following
 * `parentId` pointers yields that path deterministically; an unknown or `null`
 * id yields an empty path. (Guards against cycles defensively.)
 */
function ancestorPath(history: MessageRecord[], leafId: string | null): MessageRecord[] {
  if (leafId === null) return [];
  const byId = new Map(history.map((m) => [m.id, m] as const));
  const path: MessageRecord[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}

/** Construction dependencies for the {@link ChatService}. */
export interface ChatServiceOptions {
  /** The Model_Router seam each send is routed through (Req 3). */
  router: RoutingPort;
  /** The conversations store (tenant-scoped `ConversationRepository`). */
  conversations: ChatConversationStore;
  /** The messages store (tenant-scoped `MessageRepository`). */
  messages: ChatMessageStore;
  /** Proposes a title from the first exchange (Req 5.8); defaults to {@link DeterministicTitleGenerator}. */
  titleGenerator?: TitleGenerator;
  /** Generates unique message ids; defaults to `crypto.randomUUID`. */
  idGenerator?: MessageIdGenerator;
}

/**
 * Whether a stored title counts as "user-assigned" (non-empty after trimming).
 *
 * An empty or whitespace-only title is treated as unset, so it may be replaced
 * by an auto-generated one; any non-empty title is a user-assigned title the
 * service must never overwrite (Req 5.8).
 */
function isTitleSet(title: string | null | undefined): boolean {
  return typeof title === 'string' && title.trim() !== '';
}

/**
 * The Chat_Service. Construct once with its ports, then call its methods with
 * the acting user's {@link TenantContext} (and {@link Principal} where routing
 * or model-backed title generation is involved).
 */
export class ChatService {
  private readonly router: RoutingPort;
  private readonly conversations: ChatConversationStore;
  private readonly messages: ChatMessageStore;
  private readonly titleGenerator: TitleGenerator;
  private readonly newId: MessageIdGenerator;

  constructor(options: ChatServiceOptions) {
    this.router = options.router;
    this.conversations = options.conversations;
    this.messages = options.messages;
    this.titleGenerator = options.titleGenerator ?? new DeterministicTitleGenerator();
    this.newId = options.idGenerator ?? ((): string => randomUUID());
  }

  /**
   * Send one user message into a conversation and persist the full exchange
   * (the chat send path of Req 4, with Req 3.10's active-model behavior and
   * Req 5.8's auto-title).
   *
   * Persists the user message, routes the conversation so far through the
   * Model_Router using the effective model (request → active → Auto Mode),
   * persists the assistant response with the served model/tokens/cost (Req 3.9),
   * and auto-titles the conversation when this completes its first exchange and
   * it is still untitled (Req 5.8). Returns both messages, the routing decision
   * and outcome, the collected chunks for the Streaming_Engine to relay, and the
   * applied title when one was generated.
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param req The send request (conversation, content, optional model/prompt).
   * @param principal The authenticated actor (permission-checked routing, Req 3).
   * @returns The persisted exchange and routing result.
   * @throws {ConversationNotFoundError} when the conversation is absent in the tenant.
   * @throws Errors from the Model_Router (not authorized, no eligible model, exhausted).
   */
  async send(
    ctx: TenantContext,
    req: ChatSendRequest,
    principal: Principal,
  ): Promise<ChatSendResult> {
    const conversation = await this.conversations.findById(ctx, req.conversationId);
    if (conversation === null) {
      throw new ConversationNotFoundError(req.conversationId);
    }

    // History before this send — drives the model request and first-exchange
    // detection. Empty of assistant messages ⇒ this send is the first exchange.
    const priorMessages = await this.messages.listByConversation(ctx, req.conversationId);
    const hadAssistantResponse = priorMessages.some((m) => m.role === 'assistant');

    // Effective model (Req 3.10): explicit request wins, else the conversation's
    // active model, else Auto Mode. A switchModel earlier sets activeModelId, so
    // unspecified subsequent sends route to the switched-to model.
    const effectiveModelId = req.modelId ?? conversation.activeModelId ?? AUTO_MODEL_ID;

    // 1. Persist the user message (Req 44.6).
    const lastPriorId = priorMessages.at(-1)?.id ?? null;
    const userMessage = await this.messages.create(ctx, {
      id: this.newId(),
      conversationId: req.conversationId,
      parentId: lastPriorId,
      role: 'user',
      content: toContentBlocks(req.content),
      ...(req.attachments !== undefined ? { attachments: req.attachments } : {}),
    });

    // 2. Route the conversation so far through the Model_Router (Req 3).
    const chatRequest: ChatRequest = {
      modelId: effectiveModelId,
      messages: recordsToChatMessages([...priorMessages, userMessage]),
      ...(req.systemPrompt !== undefined ? { systemPrompt: req.systemPrompt } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    };
    const routed = await this.router.route(chatRequest, principal);

    // 3. Persist the assistant response with the served model, tokens, and cost
    // recorded by the router (Req 3.9, 44.6).
    const assistantText = chunksToText(routed.chunks);
    const assistantMessage = await this.messages.create(ctx, {
      id: this.newId(),
      conversationId: req.conversationId,
      parentId: userMessage.id,
      role: 'assistant',
      content: [{ type: 'markdown', data: { text: assistantText } }],
      model: routed.outcome.modelId,
      inputTokens: routed.outcome.inputTokens,
      outputTokens: routed.outcome.outputTokens,
      cost: routed.outcome.cost,
      latencyMs: routed.outcome.latencyMs,
    });

    // 4. Auto-title after the first exchange when still untitled (Req 5.8).
    let appliedTitle: string | undefined;
    if (!hadAssistantResponse && !isTitleSet(conversation.title)) {
      const firstUserText = blocksToText(
        (priorMessages.find((m) => m.role === 'user') ?? userMessage).content,
      );
      appliedTitle = await this.applyAutoTitle(
        ctx,
        req.conversationId,
        { conversationId: req.conversationId, userText: firstUserText, assistantText },
        principal,
      );
    }

    const result: ChatSendResult = {
      conversationId: req.conversationId,
      userMessage,
      assistantMessage,
      decision: routed.decision,
      outcome: routed.outcome,
      usage: routed.usage,
      chunks: routed.chunks,
      requestedModelId: effectiveModelId,
      ...(routed.finishReason !== undefined ? { finishReason: routed.finishReason } : {}),
      ...(appliedTitle !== undefined ? { title: appliedTitle } : {}),
    };
    return result;
  }

  /**
   * Apply a mid-conversation model switch (Req 3.10).
   *
   * Updates only the conversation's active model; prior messages keep the model
   * recorded on them, and only subsequent {@link send}s that do not name a model
   * pick up the new one. The service never rewrites previously-persisted
   * messages — the history-preservation invariant of Property 15 (task 8.4).
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param conversationId The conversation whose active model changes.
   * @param modelId The model to make active for subsequent messages.
   * @throws {ConversationNotFoundError} when the conversation is absent in the tenant.
   */
  async switchModel(ctx: TenantContext, conversationId: string, modelId: string): Promise<void> {
    const updated = await this.conversations.update(ctx, conversationId, {
      activeModelId: modelId,
    });
    if (updated === null) {
      throw new ConversationNotFoundError(conversationId);
    }
  }

  /**
   * Edit a previous message by **forking a new branch** that preserves the
   * original thread (Req 6.1).
   *
   * The edit never mutates or deletes the original message. Instead it creates
   * a *sibling* of the original — a new message sharing the original's parent
   * (the branch point) with the edited content — and, when the edited message
   * is a user message, re-routes the conversation along the new branch to
   * produce a fresh assistant reply. The original message (and everything
   * descending from it) remains intact and retrievable, which is exactly the
   * history-preservation invariant of Property 22 (task 8.8).
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param messageId The message being edited (typically a user message).
   * @param content The new content — plain text or pre-built content blocks.
   * @param principal The authenticated actor (for the re-routed reply, Req 3).
   * @param options Optional model/system-prompt/sampling overrides for the reply.
   * @returns The new branch: its root (edited) message and the re-routed reply.
   * @throws {MessageNotFoundError} when the message is absent in the tenant.
   * @throws {ConversationNotFoundError} when its conversation is absent.
   */
  async editMessage(
    ctx: TenantContext,
    messageId: string,
    content: string | ContentBlock[],
    principal: Principal,
    options: EditMessageOptions = {},
  ): Promise<Branch> {
    const original = await this.messages.findById(ctx, messageId);
    if (original === null) {
      throw new MessageNotFoundError(messageId);
    }
    const conversationId = original.conversationId;
    const conversation = await this.conversations.findById(ctx, conversationId);
    if (conversation === null) {
      throw new ConversationNotFoundError(conversationId);
    }

    // Fork: the edit is a sibling sharing the original's parent (the branch
    // point), so the original thread is never touched (Req 6.1).
    const branchPointId = original.parentId;
    const history = await this.messages.listByConversation(ctx, conversationId);
    const editedMessage = await this.messages.create(ctx, {
      id: this.newId(),
      conversationId,
      parentId: branchPointId,
      role: original.role,
      content: toContentBlocks(content),
      ...(original.attachments.length > 0 ? { attachments: original.attachments } : {}),
    });

    const branch: Branch = {
      conversationId,
      branchPointId,
      sourceMessageId: messageId,
      rootMessage: editedMessage,
    };

    // Re-route along the new branch to produce a fresh reply only when the
    // edited message is a user turn (Req 6.1).
    if (original.role === 'user') {
      const context = [...ancestorPath(history, branchPointId), editedMessage];
      const modelId = options.modelId ?? conversation.activeModelId ?? AUTO_MODEL_ID;
      const { message: assistantMessage, routed } = await this.routeAndPersistAssistant(
        ctx,
        conversationId,
        editedMessage.id,
        context,
        modelId,
        principal,
        options,
      );
      branch.assistantMessage = assistantMessage;
      branch.decision = routed.decision;
      branch.outcome = routed.outcome;
    }

    return branch;
  }

  /**
   * Branch a conversation at a selected message by creating a **child branch
   * that references the selected message as its parent** (Req 6.2).
   *
   * The selected message is left untouched; a new message is created with its
   * `parentId` set to the selected message, rooting an independent branch that
   * shares all history up to that point. The branch root copies the selected
   * message's role and content so the new path can be navigated and continued
   * on its own.
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param messageId The message to branch from.
   * @returns The new branch whose root references the selected message as parent.
   * @throws {MessageNotFoundError} when the message is absent in the tenant.
   */
  async branch(ctx: TenantContext, messageId: string): Promise<Branch> {
    const selected = await this.messages.findById(ctx, messageId);
    if (selected === null) {
      throw new MessageNotFoundError(messageId);
    }
    const conversationId = selected.conversationId;
    const child = await this.messages.create(ctx, {
      id: this.newId(),
      conversationId,
      parentId: selected.id,
      role: selected.role,
      content: selected.content,
      ...(selected.model !== null ? { model: selected.model } : {}),
      ...(selected.attachments.length > 0 ? { attachments: selected.attachments } : {}),
    });
    return {
      conversationId,
      branchPointId: selected.id,
      sourceMessageId: selected.id,
      rootMessage: child,
    };
  }

  /**
   * Regenerate a response using a user-selected model while **retaining the
   * prior response** in history (Req 6.3).
   *
   * The prior assistant message is never overwritten. A brand-new assistant
   * message is created as a *sibling* referencing the same parent (the user
   * message that prompted the response), routed with the requested model. Both
   * responses then coexist under the same parent.
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param messageId The assistant message to regenerate.
   * @param modelId The user-selected model to route the regeneration through.
   * @param principal The authenticated actor (permission-checked routing, Req 3).
   * @returns The retained prior message and the newly-created sibling response.
   * @throws {MessageNotFoundError} when the message is absent in the tenant.
   */
  async regenerate(
    ctx: TenantContext,
    messageId: string,
    modelId: string,
    principal: Principal,
  ): Promise<RegenerateResult> {
    const prior = await this.messages.findById(ctx, messageId);
    if (prior === null) {
      throw new MessageNotFoundError(messageId);
    }
    const conversationId = prior.conversationId;
    const history = await this.messages.listByConversation(ctx, conversationId);

    // The new response is a sibling of the prior one: same parent user message.
    const parentId = prior.parentId;
    const context = ancestorPath(history, parentId);
    const { message: assistantMessage, routed } = await this.routeAndPersistAssistant(
      ctx,
      conversationId,
      parentId,
      context,
      modelId,
      principal,
      {},
    );
    return {
      conversationId,
      priorMessage: prior,
      assistantMessage,
      decision: routed.decision,
      outcome: routed.outcome,
      requestedModelId: modelId,
    };
  }

  /**
   * Compare models by submitting one prompt to **each selected model** and
   * returning the responses for side-by-side display (Req 6.4).
   *
   * A single user message carrying the prompt is persisted, then the prompt is
   * fanned out to each model through the {@link RoutingPort}; each model's
   * response is persisted as a sibling child of the shared prompt. The returned
   * array holds one entry per model, in the order requested.
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param req The comparison prompt and its conversation.
   * @param modelIds The models to fan the prompt out to.
   * @param principal The authenticated actor (permission-checked routing, Req 3).
   * @returns One {@link CompareResult} per model, in request order.
   * @throws {ConversationNotFoundError} when the conversation is absent in the tenant.
   */
  async compare(
    ctx: TenantContext,
    req: ChatCompareRequest,
    modelIds: string[],
    principal: Principal,
  ): Promise<CompareResult[]> {
    const conversation = await this.conversations.findById(ctx, req.conversationId);
    if (conversation === null) {
      throw new ConversationNotFoundError(req.conversationId);
    }

    const prior = await this.messages.listByConversation(ctx, req.conversationId);
    const lastPriorId = prior.at(-1)?.id ?? null;

    // One shared prompt; each model's reply is a sibling child of it (Req 6.4).
    const userMessage = await this.messages.create(ctx, {
      id: this.newId(),
      conversationId: req.conversationId,
      parentId: lastPriorId,
      role: 'user',
      content: toContentBlocks(req.content),
    });
    const context = [...prior, userMessage];

    const results: CompareResult[] = [];
    for (const modelId of modelIds) {
      const { message: assistantMessage, routed } = await this.routeAndPersistAssistant(
        ctx,
        req.conversationId,
        userMessage.id,
        context,
        modelId,
        principal,
        req,
      );
      results.push({
        modelId,
        assistantMessage,
        decision: routed.decision,
        outcome: routed.outcome,
      });
    }
    return results;
  }

  /**
   * Persist a user's rating for a response (Req 6.5).
   *
   * Records the thumbs-up/neutral/thumbs-down rating on the message via the
   * message store. Returns the updated record.
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param messageId The message being rated.
   * @param rating The rating to persist (`up` | `neutral` | `down`).
   * @returns The updated message record carrying the persisted rating.
   * @throws {MessageNotFoundError} when the message is absent in the tenant.
   */
  async rate(ctx: TenantContext, messageId: string, rating: MessageRating): Promise<MessageRecord> {
    const updated = await this.messages.update(ctx, messageId, { rating });
    if (updated === null) {
      throw new MessageNotFoundError(messageId);
    }
    return updated;
  }

  /**
   * Route a context window through the Model_Router and persist the assistant
   * response as a child of `parentId`, recording the served model, tokens,
   * cost, and latency (Req 3.9, 44.6). Shared by edit/regenerate/compare.
   */
  private async routeAndPersistAssistant(
    ctx: TenantContext,
    conversationId: string,
    parentId: string | null,
    context: MessageRecord[],
    modelId: string,
    principal: Principal,
    opts: RouteOverrides,
  ): Promise<{ message: MessageRecord; routed: RoutedChatResult }> {
    const chatRequest: ChatRequest = {
      modelId,
      messages: recordsToChatMessages(context),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    };
    const routed = await this.router.route(chatRequest, principal);
    const text = chunksToText(routed.chunks);
    const message = await this.messages.create(ctx, {
      id: this.newId(),
      conversationId,
      parentId,
      role: 'assistant',
      content: [{ type: 'markdown', data: { text } }],
      model: routed.outcome.modelId,
      inputTokens: routed.outcome.inputTokens,
      outputTokens: routed.outcome.outputTokens,
      cost: routed.outcome.cost,
      latencyMs: routed.outcome.latencyMs,
    });
    return { message, routed };
  }

  /**
   * Generate (and apply, when untitled) a title summarizing a conversation
   * (Req 5.8).
   *
   * If the conversation already has a user-assigned title, it is returned
   * unchanged — never overwritten. Otherwise a title is generated from the
   * first exchange and applied via the conversation store, and the applied title
   * is returned. Idempotent: a second call after a title exists returns it.
   *
   * @param ctx The caller's tenant context (Organization scope, Req 1.2).
   * @param conversationId The conversation to title.
   * @param principal The authenticated actor (for a permission-scoped model call).
   * @returns The conversation's title after this call.
   * @throws {ConversationNotFoundError} when the conversation is absent in the tenant.
   */
  async generateTitle(
    ctx: TenantContext,
    conversationId: string,
    principal: Principal,
  ): Promise<string> {
    const conversation = await this.conversations.findById(ctx, conversationId);
    if (conversation === null) {
      throw new ConversationNotFoundError(conversationId);
    }
    if (isTitleSet(conversation.title)) {
      // Never overwrite a user-assigned title (Req 5.8).
      return conversation.title;
    }

    const source = await this.buildTitleSource(ctx, conversationId);
    const applied = await this.applyAutoTitle(ctx, conversationId, source, principal);
    return applied ?? conversation.title;
  }

  /**
   * Generate a title from `source`, then apply it via the conversation store
   * only when the conversation is still untitled (Req 5.8).
   *
   * Re-reads the conversation immediately before updating so a title a user
   * assigned in the meantime is never overwritten; returns the applied title, or
   * `undefined` when a title now exists (no change made).
   */
  private async applyAutoTitle(
    ctx: TenantContext,
    conversationId: string,
    source: TitleSource,
    principal: Principal,
  ): Promise<string | undefined> {
    const proposed = await this.titleGenerator.generate(source, principal);
    const title = normalizeTitle(proposed);

    // Re-check just before writing: never overwrite a user-assigned title.
    const current = await this.conversations.findById(ctx, conversationId);
    if (current === null || isTitleSet(current.title)) {
      return undefined;
    }
    await this.conversations.update(ctx, conversationId, { title });
    return title;
  }

  /** Build a {@link TitleSource} from a conversation's first user/assistant texts. */
  private async buildTitleSource(ctx: TenantContext, conversationId: string): Promise<TitleSource> {
    const messages = await this.messages.listByConversation(ctx, conversationId);
    const firstUser = messages.find((m) => m.role === 'user');
    const firstAssistant = messages.find((m) => m.role === 'assistant');
    return {
      conversationId,
      userText: firstUser !== undefined ? blocksToText(firstUser.content) : '',
      assistantText: firstAssistant !== undefined ? blocksToText(firstAssistant.content) : '',
    };
  }
}

/** Re-exported record aliases for callers composing the Chat_Service result. */
export type { ConversationRecord, MessageRecord };
