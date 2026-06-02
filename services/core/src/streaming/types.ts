/**
 * The Streaming_Engine contract (Req 4.1-4.5).
 *
 * The Streaming_Engine relays a provider's incremental {@link ChatChunk} stream
 * to a connected client token-by-token (Req 4.1, 4.2), emits a terminal
 * completion event carrying the model, total token counts, and total cost
 * (Req 4.3), and — when a user cancels (Req 4.4) or the client disconnects
 * (Req 4.5) — stops and persists the prefix of tokens received so far.
 *
 * It is deliberately **transport-agnostic**: the engine never knows whether it
 * is writing to Server-Sent Events or a WebSocket. Both are modeled behind the
 * narrow {@link EventSink} port (an SSE or WebSocket adapter implements `emit`),
 * cancellation behind a standard {@link AbortSignal}, a client disconnect as a
 * sink whose `emit` throws/rejects, and persistence behind the injectable
 * {@link PartialResponsePersister} port. That keeps the engine fully testable
 * with in-memory fakes and an {@link AbortController}, with no real SSE,
 * WebSocket, timers, or network involved.
 */

import type { ChatFinishReason, ModelCost, TokenUsage } from '@auxify/types';

/**
 * An incremental token event delivered to the client as the model emits it
 * (Req 4.2).
 *
 * One token event is emitted per non-empty {@link ChatChunk.delta}, *before*
 * the response is complete (Req 4.1, 4.2). `index` is the 0-based ordinal of
 * the token event within the stream, so a transport adapter (and tests) can
 * assert ordering and reassemble the prefix.
 */
export interface TokenStreamEvent {
  /** Discriminant: an incremental token. */
  type: 'token';
  /** The incremental text produced since the previous token (Req 4.2). */
  delta: string;
  /** 0-based ordinal of this token event within the stream. */
  index: number;
}

/**
 * The terminal completion event (Req 4.3).
 *
 * Emitted exactly once, after the source stream completes normally, carrying
 * the facts Req 4.3 enumerates: the model that produced the response, the total
 * {@link TokenUsage}, and the total {@link cost} for the message. It is *not*
 * emitted when the stream is cancelled (Req 4.4) or the client disconnects
 * (Req 4.5).
 */
export interface CompletionStreamEvent {
  /** Discriminant: the terminal completion. */
  type: 'completion';
  /** The model that produced the response (Req 4.3). */
  model: string;
  /** Total token counts for the message (Req 4.3). */
  usage: TokenUsage;
  /** Total cost for the message (Req 4.3). */
  cost: number;
  /** Why generation stopped, when the provider reported it. */
  finishReason?: ChatFinishReason;
}

/**
 * An event delivered to the client over the {@link EventSink}: either an
 * incremental {@link TokenStreamEvent} (Req 4.2) or the terminal
 * {@link CompletionStreamEvent} (Req 4.3).
 */
export type StreamEvent = TokenStreamEvent | CompletionStreamEvent;

/**
 * The transport-agnostic port the Streaming_Engine pushes events to (Req 4.1).
 *
 * An SSE adapter implements `emit` by writing an `event:`/`data:` frame; a
 * WebSocket adapter implements it by sending a message. The engine treats a
 * thrown/rejected `emit` as a **client disconnect** (Req 4.5): it stops relaying
 * and persists the prefix received so far. `emit` may be synchronous or return
 * a promise; the engine awaits it either way so back-pressure is respected.
 */
export interface EventSink {
  /**
   * Deliver one {@link StreamEvent} to the connected client.
   *
   * @param event The token or completion event to transmit.
   * @throws when the client connection has dropped — the engine treats this as
   *   a disconnect and persists the received prefix (Req 4.5).
   */
  emit(event: StreamEvent): void | Promise<void>;
}

/**
 * Identifies the message a partial response is persisted against (Req 4.4,
 * 4.5).
 *
 * The Streaming_Engine does not own message storage; it hands the
 * {@link PartialResponsePersister} the conversation/message coordinates and the
 * received prefix, and the Chat_Service's persistence layer writes it.
 */
export interface PersistenceTarget {
  /** The conversation the streamed assistant message belongs to. */
  conversationId: string;
  /** The id of the (assistant) message being streamed. */
  messageId: string;
}

/** Why a partial response is being persisted. */
export type PartialResponseReason = 'cancelled' | 'disconnected';

/**
 * The prefix of a streamed response persisted on cancel or disconnect
 * (Req 4.4, 4.5).
 *
 * `text` is the concatenation of every token delta received up to the
 * cancellation/disconnection point; `usage` is the best-effort token usage
 * reported by the provider so far (typically `{0, 0}` because the terminal
 * usage chunk has not arrived yet); `reason` distinguishes a user cancel
 * (Req 4.4) from a client disconnect (Req 4.5).
 */
export interface PartialResponse {
  /** Where to persist the prefix. */
  target: PersistenceTarget;
  /** The received prefix — every token delta up to the stop point (Req 4.4, 4.5). */
  text: string;
  /** Best-effort token usage reported so far (often `{0, 0}`). */
  usage: TokenUsage;
  /** The model that produced the prefix, when known. */
  model?: string;
  /** Whether the stop was a user cancel (Req 4.4) or a client disconnect (Req 4.5). */
  reason: PartialResponseReason;
}

/**
 * The injectable persistence port — the Chat_Service hook the Streaming_Engine
 * calls to persist the received prefix on cancel (Req 4.4) or disconnect
 * (Req 4.5).
 *
 * Modeling persistence as a port (rather than a concrete repository call) keeps
 * the engine transport- and storage-agnostic and unit-testable with an
 * in-memory fake. Implementations may no-op on an empty prefix; the engine
 * always delegates the decision rather than second-guessing it.
 */
export interface PartialResponsePersister {
  /**
   * Persist the received prefix of a cancelled/disconnected stream.
   *
   * @param partial The target, prefix text, usage-so-far, model, and reason.
   */
  persist(partial: PartialResponse): void | Promise<void>;
}

/**
 * How the total message {@link CompletionStreamEvent.cost} is determined
 * (Req 4.3).
 *
 * Three equivalent forms are accepted so a caller can supply whichever it has
 * on hand, mirroring the Model_Router's `computeCost` shape:
 *
 *   - a `number` — a precomputed total cost (e.g. the
 *     `RequestOutcome.cost` the router already recorded), used verbatim;
 *   - a {@link ModelCost} — the model's per-1k input/output costs, from which
 *     the engine computes `inputTokens/1000 * per1kInputTokens +
 *     outputTokens/1000 * per1kOutputTokens` using the final usage (identical
 *     to the router's `computeCost`);
 *   - a {@link CostFn} — a custom function mapping the final usage to a cost.
 */
export type CostSource = number | ModelCost | CostFn;

/** A custom cost function mapping final {@link TokenUsage} to a total cost. */
export type CostFn = (usage: TokenUsage) => number;

/**
 * Per-request context the transport adapter supplies to
 * {@link import('./streaming-engine.js').StreamingEngine.stream}.
 *
 * It carries everything that varies per streamed message: where to persist a
 * partial response ({@link target}), how to price the message ({@link cost}),
 * the model id to report when the provider chunks omit it ({@link modelId}),
 * and the cooperative cancellation {@link signal} (Req 4.4).
 */
export interface StreamContext {
  /** Where a partial response is persisted on cancel/disconnect (Req 4.4, 4.5). */
  target: PersistenceTarget;
  /** How the completion event's total cost is computed (Req 4.3). */
  cost: CostSource;
  /**
   * The model id to report in the completion/partial events when the provider's
   * chunks do not carry one. A model id on a chunk always takes precedence.
   */
  modelId?: string;
  /** Cooperative cancellation signal for a user cancel (Req 4.4). */
  signal?: AbortSignal;
}

/** The terminal status of a {@link StreamResult}. */
export type StreamStatus =
  /** The source stream completed and a completion event was emitted (Req 4.3). */
  | 'completed'
  /** The user cancelled; transmission stopped and the prefix was persisted (Req 4.4). */
  | 'cancelled'
  /** The client disconnected; the prefix generated before the drop was persisted (Req 4.5). */
  | 'disconnected';

/**
 * The summary the Streaming_Engine returns once a stream settles (Req 4.3-4.5).
 *
 * It records what happened ({@link status}), the accumulated response
 * {@link text}, the {@link usage}/{@link model}/{@link cost} (the same facts the
 * completion event carries on success), the number of events emitted to the
 * sink ({@link eventCount}), the provider {@link finishReason} when reported,
 * and whether a partial response was {@link persisted} (true exactly when the
 * status is `cancelled` or `disconnected`).
 */
export interface StreamResult {
  /** What happened: completed, cancelled, or disconnected. */
  status: StreamStatus;
  /** The accumulated response text — every received token delta concatenated. */
  text: string;
  /** Total (or best-effort partial) token usage. */
  usage: TokenUsage;
  /** The model that produced the response (`''` when never reported, e.g. an immediate cancel). */
  model: string;
  /** The total (or partial) cost computed from {@link usage} and the context's cost source. */
  cost: number;
  /** The number of events emitted to the sink (token events plus the completion event). */
  eventCount: number;
  /** Why generation stopped, when the provider reported it. */
  finishReason?: ChatFinishReason;
  /** Whether a partial response was persisted (true for `cancelled`/`disconnected`). */
  persisted: boolean;
}
