/**
 * Chat_Service domain types and injected ports (Req 3.10, 5.8, and the chat
 * send path of Req 4).
 *
 * The Chat_Service orchestrates a single chat *send* end to end: it persists
 * the user's message, routes the exchange through the Model_Router, persists the
 * assistant's response with the model/tokens/cost the router recorded, and —
 * after the first exchange of an untitled conversation — auto-generates a title.
 * It also applies a mid-conversation model switch that affects only subsequent
 * messages (Req 3.10).
 *
 * Every effect is an injectable port so the service is unit-testable with
 * fakes, with no real providers, network, or database:
 *
 *   - {@link RoutingPort} — the Model_Router seam (`ModelRouter.route`
 *     structurally satisfies it); a fake returns a canned {@link RoutedChatResult}.
 *   - {@link ChatConversationStore} — the narrow conversation persistence the
 *     service needs (`ConversationRepository` satisfies it): read the active
 *     model + title, and update the active model (Req 3.10) and the title
 *     (Req 5.8).
 *   - {@link ChatMessageStore} — the narrow message persistence the service
 *     needs (`MessageRepository` satisfies it): append the user/assistant
 *     messages and read prior history to build the model request.
 *
 * These are camelCase domain shapes distinct from the snake_case persistence
 * rows; the service maps between them via the repository records.
 */

import type {
  ChatChunk,
  ChatFinishReason,
  ChatRequest,
  ContentBlock,
  Principal,
  TenantContext,
  TokenUsage,
} from '@auxify/types';

import type {
  ConversationRecord,
  CreateMessageInput,
  ListOptions,
  MessageRating,
  MessageRecord,
  UpdateConversationInput,
  UpdateMessageInput,
} from '../repositories/index.js';
import type { RequestOutcome, RouteDecision, RoutedChatResult } from '../router/index.js';

/**
 * The Model_Router seam the Chat_Service routes each send through (Req 3).
 *
 * The unified `ModelRouter.route` structurally satisfies this port: given a
 * {@link ChatRequest} (whose `modelId` is the effective model — an explicit id,
 * the conversation's active model, or {@link import('../router/index.js').AUTO_MODEL_ID})
 * and the authenticated {@link Principal}, it resolves permissions, selects and
 * executes the model with fallback, records the outcome, and returns the
 * collected {@link RoutedChatResult}. A fake returning a canned result keeps the
 * Chat_Service unit-testable without real providers.
 */
export interface RoutingPort {
  /**
   * Route and execute a chat request end to end (Req 3.1-3.9).
   *
   * @param req The chat request, with `modelId` set to the effective model.
   * @param principal The authenticated actor making the request.
   * @returns The successful routed result (decision, outcome, chunks, usage).
   */
  route(req: ChatRequest, principal: Principal): Promise<RoutedChatResult>;
}

/**
 * The narrow conversation persistence the Chat_Service composes (Req 3.10, 5.8).
 *
 * `ConversationRepository` satisfies this structurally; tests substitute an
 * in-memory fake. The service only needs to *read* a conversation (for its
 * active model and current title) and *update* it (to switch the active model,
 * Req 3.10, and to apply an auto-generated title, Req 5.8).
 */
export interface ChatConversationStore {
  /** Fetch a conversation by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<ConversationRecord | null>;
  /** Update a conversation by id within the caller's Organization, or `null` if absent. */
  update(
    ctx: TenantContext,
    id: string,
    input: UpdateConversationInput,
  ): Promise<ConversationRecord | null>;
}

/**
 * The narrow message persistence the Chat_Service composes (Req 4.x).
 *
 * `MessageRepository` satisfies this structurally; tests substitute an
 * in-memory fake. The service appends the user and assistant messages of each
 * exchange and reads prior history to build the model request and detect the
 * first exchange (Req 5.8).
 */
export interface ChatMessageStore {
  /** Persist a message under a conversation in the caller's Organization (Req 44.6). */
  create(ctx: TenantContext, input: CreateMessageInput): Promise<MessageRecord>;
  /** Fetch a single message by id within the caller's Organization, or `null`. */
  findById(ctx: TenantContext, id: string): Promise<MessageRecord | null>;
  /** List a conversation's messages in chronological order, tenant-scoped. */
  listByConversation(
    ctx: TenantContext,
    conversationId: string,
    options?: Pick<ListOptions, 'limit' | 'offset'>,
  ): Promise<MessageRecord[]>;
  /**
   * Update a message's mutable fields (rating, pinned) within the caller's
   * Organization, returning the updated record or `null` if absent (Req 6.5).
   */
  update(ctx: TenantContext, id: string, input: UpdateMessageInput): Promise<MessageRecord | null>;
}

/**
 * A request to send one user message into a conversation and get the model's
 * reply (the chat send path of Req 4, plus Req 3.10's active-model behavior).
 *
 * `content` is the user's message — plain text or pre-built {@link ContentBlock}s.
 * `modelId` is the model to route to; when omitted, the Chat_Service falls back
 * to the conversation's active model and finally to Auto Mode, so a
 * mid-conversation {@link ChatService.switchModel} naturally governs subsequent
 * sends without the caller re-specifying the model (Req 3.10).
 */
export interface ChatSendRequest {
  /** The conversation to append the exchange to. */
  conversationId: string;
  /** The user's message — plain text or pre-built content blocks. */
  content: string | ContentBlock[];
  /**
   * The model to route to. When omitted, the conversation's active model is
   * used, and Auto Mode when there is none (Req 3.10).
   */
  modelId?: string;
  /** An optional system prompt applied ahead of the conversation history. */
  systemPrompt?: string;
  /** Optional attachments persisted on the user message (Req 7.x). */
  attachments?: unknown[];
  /** Sampling temperature, forwarded to the model request. */
  temperature?: number;
  /** Maximum tokens to generate, forwarded to the model request. */
  maxTokens?: number;
}

/**
 * The result of a completed {@link ChatService.send} (the chat send path).
 *
 * It returns both persisted messages of the exchange, the routing
 * {@link RouteDecision} and recorded {@link RequestOutcome} (selected model,
 * latency, tokens, cost — Req 3.9), the terminal {@link TokenUsage} and finish
 * reason, and the provider's collected {@link ChatChunk}s so a gateway can relay
 * them to the client via the Streaming_Engine (see the streaming seam in
 * `chat-service.ts`). `title` is set only when an auto-title was generated and
 * applied on the first exchange of a previously-untitled conversation (Req 5.8).
 */
export interface ChatSendResult {
  /** The conversation the exchange was appended to. */
  conversationId: string;
  /** The persisted user message. */
  userMessage: MessageRecord;
  /** The persisted assistant message (carries the served model, tokens, cost). */
  assistantMessage: MessageRecord;
  /** The routing decision for the model that ultimately served the request. */
  decision: RouteDecision;
  /** The recorded outcome (selected model, latency, tokens, cost) (Req 3.9). */
  outcome: RequestOutcome;
  /** The terminal token usage reported by the provider. */
  usage: TokenUsage;
  /** Why generation stopped, from the provider's terminal chunk, when reported. */
  finishReason?: ChatFinishReason;
  /** The provider's collected chunks, for the Streaming_Engine to relay (Req 4.2). */
  chunks: ChatChunk[];
  /** The effective model id the request was routed with (explicit/active/auto). */
  requestedModelId: string;
  /** The auto-generated title applied on the first exchange, when one was (Req 5.8). */
  title?: string;
}

/**
 * The new branch created by {@link ChatService.editMessage} or
 * {@link ChatService.branch} (Req 6.1, 6.2).
 *
 * A "branch" is a divergence in the conversation's parent-linked message tree.
 * The {@link Branch.branchPointId} is the message the new branch hangs off (the
 * edited message's parent for an edit; the selected message for a plain
 * branch). The newly-created message(s) reference an in-tree parent so the
 * original thread is never mutated or detached — the history-preservation
 * invariant of Property 22 (task 8.8). For an edit, {@link Branch.assistantMessage}
 * carries the re-routed reply on the new branch.
 */
export interface Branch {
  /** The conversation the branch belongs to. */
  conversationId: string;
  /**
   * The message the new branch diverges from — the parent the new branch's
   * root message references. For {@link ChatService.editMessage} this is the
   * edited message's own parent (so the edit is a sibling of the original); for
   * {@link ChatService.branch} this is the selected message itself.
   */
  branchPointId: string | null;
  /** The id of the original message the branch was derived from. */
  sourceMessageId: string;
  /** The new branch's root message (the edited user message, or the branch copy). */
  rootMessage: MessageRecord;
  /**
   * The assistant reply re-routed on the new branch, present when the branch
   * root is a user message that warrants a response (an edit, Req 6.1).
   */
  assistantMessage?: MessageRecord;
  /** The routing decision/outcome for the re-routed reply, when one was produced. */
  decision?: RouteDecision;
  /** The recorded outcome of the re-routed reply, when one was produced. */
  outcome?: RequestOutcome;
}

/**
 * The result of regenerating a response (Req 6.3).
 *
 * The prior assistant response is retained; a brand-new assistant message is
 * created as a sibling referencing the same parent user message, optionally
 * with a user-selected model. {@link RegenerateResult.priorMessage} is the
 * retained original so callers can show "regenerated" alongside it.
 */
export interface RegenerateResult {
  /** The conversation the regeneration belongs to. */
  conversationId: string;
  /** The retained prior assistant message (never mutated). */
  priorMessage: MessageRecord;
  /** The newly-created assistant message (a sibling of the prior one). */
  assistantMessage: MessageRecord;
  /** The routing decision for the regenerated response. */
  decision: RouteDecision;
  /** The recorded outcome (model, latency, tokens, cost) of the regeneration. */
  outcome: RequestOutcome;
  /** The model id the regeneration was routed with. */
  requestedModelId: string;
}

/**
 * The prompt submitted to several models for side-by-side comparison
 * (Req 6.4), the `PromptInput` of the design's `compare(prompt, modelIds)`.
 *
 * `content` is the prompt — plain text or pre-built {@link ContentBlock}s. The
 * comparison persists one user message and one assistant message per selected
 * model under `conversationId`, so each model's response is durable and
 * independently retrievable.
 */
export interface ChatCompareRequest {
  /** The conversation the comparison messages are appended to. */
  conversationId: string;
  /** The prompt to submit to every selected model. */
  content: string | ContentBlock[];
  /** An optional system prompt applied ahead of the prompt for every model. */
  systemPrompt?: string;
  /** Sampling temperature forwarded to each model request. */
  temperature?: number;
  /** Maximum tokens to generate, forwarded to each model request. */
  maxTokens?: number;
}

/**
 * One model's response in a {@link ChatService.compare} fan-out (Req 6.4).
 *
 * The same prompt is submitted to each selected model and the responses are
 * returned for side-by-side display. Each entry carries the model requested,
 * the persisted assistant message, and the routing decision/outcome.
 */
export interface CompareResult {
  /** The model id this response was requested for. */
  modelId: string;
  /** The persisted assistant message produced by this model. */
  assistantMessage: MessageRecord;
  /** The routing decision for this model's response. */
  decision: RouteDecision;
  /** The recorded outcome (model, latency, tokens, cost) for this model. */
  outcome: RequestOutcome;
}

/** Re-exported rating union so callers can type the {@link ChatService.rate} argument. */
export type { MessageRating };
