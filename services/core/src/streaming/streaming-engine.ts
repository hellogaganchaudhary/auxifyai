/**
 * The Streaming_Engine (Req 4.1-4.5).
 *
 * The Model_Router collects a provider's response and hands the
 * Streaming_Engine the incremental {@link ChatChunk} stream (see
 * `RoutedChatResult.chunks`); this engine is the piece that *relays* those
 * chunks to a connected client token-by-token. It is the single place the
 * platform's "stream while the model emits, then summarize, and never lose what
 * was already produced" behavior lives:
 *
 *   - **Incremental delivery (Req 4.1, 4.2).** For every non-empty chunk delta,
 *     the engine emits one {@link TokenStreamEvent} to the {@link EventSink}
 *     *as the chunk arrives* — before the source stream completes — so the
 *     client renders tokens live. The engine adds no artificial latency (the
 *     p95 TTFT ≤ 2s target, Req 4.6, is validated under load elsewhere).
 *   - **Completion event (Req 4.3).** When the source completes normally, the
 *     engine emits exactly one {@link CompletionStreamEvent} carrying the model
 *     used, the total {@link TokenUsage}, and the total cost for the message.
 *   - **User cancel (Req 4.4).** When the injected {@link AbortSignal} aborts,
 *     the engine stops relaying immediately and persists the prefix of tokens
 *     received so far through the {@link PartialResponsePersister}.
 *   - **Client disconnect (Req 4.5).** When the sink's `emit` throws/rejects
 *     (the transport modeling a dropped connection), the engine stops relaying
 *     and persists the prefix generated before the drop.
 *
 * Every effect is an injectable port — the sink, the persister, and the
 * cancellation signal — so the engine is deterministic under test with no real
 * SSE, WebSocket, timers, or network. The source is any
 * `AsyncIterable<ChatChunk>` (a fake async generator in tests; the router's
 * collected chunks or a live provider stream in production).
 */

import type { ChatChunk, ChatFinishReason, ModelCost, TokenUsage } from '@auxify/types';

import type {
  CostSource,
  EventSink,
  PartialResponse,
  PartialResponsePersister,
  StreamContext,
  StreamEvent,
  StreamResult,
} from './types.js';

/**
 * A provider chat chunk — the input unit the engine relays. Aliased to the
 * shared {@link ChatChunk} so the engine consumes exactly what the
 * Provider_Abstraction_Layer and Model_Router produce (the design's
 * `ProviderChunk`).
 */
export type ProviderChunk = ChatChunk;

/** Construction dependencies for a {@link StreamingEngine}. */
export interface StreamingEngineOptions {
  /** Persists the received prefix on cancel (Req 4.4) or disconnect (Req 4.5). */
  persister: PartialResponsePersister;
}

/**
 * Whether a cancellation {@link AbortSignal} has fired (Req 4.4).
 *
 * Read through a function call rather than inline so the engine can re-check it
 * at several points in the relay loop: an `AbortSignal.aborted` getter can flip
 * from `false` to `true` between chunks, but TypeScript's control-flow analysis
 * would otherwise narrow a prior inline `signal.aborted === true` check to a
 * constant `false` for the rest of the scope.
 *
 * @param signal The cancellation signal, or `undefined` when none was supplied.
 * @returns `true` when the signal exists and has aborted.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Relays a provider chunk stream to a client, transport-agnostically (Req
 * 4.1-4.5).
 *
 * Stateless beyond its injected {@link PartialResponsePersister}, so a single
 * instance safely serves many concurrent streams — all per-stream state lives
 * in {@link stream}'s local scope.
 */
export class StreamingEngine {
  private readonly persister: PartialResponsePersister;

  /** @param options The injected persistence port. */
  constructor(options: StreamingEngineOptions) {
    this.persister = options.persister;
  }

  /**
   * Relay `source` to `sink` and settle into a {@link StreamResult} (Req
   * 4.1-4.5).
   *
   * The engine emits one token event per non-empty chunk delta as it arrives
   * (Req 4.1, 4.2), accumulating the prefix and the latest usage/model/finish
   * reason. On normal completion it emits the completion event with model,
   * tokens, and cost (Req 4.3) and returns `status: 'completed'`. If `signal`
   * aborts at any point it stops and persists the prefix (Req 4.4,
   * `status: 'cancelled'`); if `sink.emit` throws it stops and persists the
   * prefix (Req 4.5, `status: 'disconnected'`). Cancel and disconnect never
   * emit a completion event.
   *
   * @param source The provider's incremental chunk stream.
   * @param sink The transport-agnostic event sink (SSE/WebSocket adapter, or a fake).
   * @param ctx Per-request target, cost source, model id, and cancellation signal.
   * @returns A summary of what happened, the accumulated text, usage, model, and cost.
   */
  async stream(
    source: AsyncIterable<ProviderChunk>,
    sink: EventSink,
    ctx: StreamContext,
  ): Promise<StreamResult> {
    const signal = ctx.signal;
    let text = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let model = ctx.modelId ?? '';
    let finishReason: ChatFinishReason | undefined;
    let tokenIndex = 0;
    let eventCount = 0;

    // A user cancel that arrives before/between chunks (Req 4.4): stop before
    // pulling the next chunk so an already-aborted stream emits nothing.
    if (isAborted(signal)) {
      return this.settlePartial({
        ctx,
        sink,
        text,
        usage,
        model,
        finishReason,
        eventCount,
        reason: 'cancelled',
      });
    }

    const iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Req 4.4: a cancel between chunks stops transmission and persists.
        if (isAborted(signal)) {
          await closeIterator(iterator);
          return this.settlePartial({
            ctx,
            sink,
            text,
            usage,
            model,
            finishReason,
            eventCount,
            reason: 'cancelled',
          });
        }

        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const chunk = next.value;

        // Track the latest provider-reported model, usage, and finish reason.
        if (chunk.model !== undefined) {
          model = chunk.model;
        }
        if (chunk.usage !== undefined) {
          usage = { ...chunk.usage };
        }
        if (chunk.finishReason !== undefined) {
          finishReason = chunk.finishReason;
        }

        // Req 4.4 again: re-check after the (possibly slow) pull so a cancel
        // that landed *during* it is honored before we emit this token.
        if (isAborted(signal)) {
          await closeIterator(iterator);
          return this.settlePartial({
            ctx,
            sink,
            text,
            usage,
            model,
            finishReason,
            eventCount,
            reason: 'cancelled',
          });
        }

        // Req 4.1, 4.2: emit each non-empty token delta incrementally, before
        // the stream completes. Empty deltas (e.g. the terminal usage-only
        // chunk) carry no token and are not surfaced as token events.
        if (chunk.delta !== '') {
          text += chunk.delta;
          try {
            await sink.emit({ type: 'token', delta: chunk.delta, index: tokenIndex });
          } catch (error) {
            // Req 4.5: the client disconnected — stop and persist the prefix.
            await closeIterator(iterator);
            return this.settlePartial({
              ctx,
              sink,
              text,
              usage,
              model,
              finishReason,
              eventCount,
              reason: 'disconnected',
              disconnected: true,
              cause: error,
            });
          }
          tokenIndex += 1;
          eventCount += 1;
        }
      }
    } catch (error) {
      // The source stream itself failed. Make sure the iterator is closed and
      // re-raise — this is a provider/source error, not a client disconnect,
      // and is the Model_Router's domain (fallback), not the engine's.
      await closeIterator(iterator);
      throw error;
    }

    // Req 4.3: the source completed — emit the completion event with the model
    // used, total token counts, and total cost for the message.
    const cost = computeStreamCost(ctx.cost, usage);
    const completion: StreamEvent = {
      type: 'completion',
      model,
      usage,
      cost,
      ...(finishReason !== undefined ? { finishReason } : {}),
    };

    try {
      await sink.emit(completion);
    } catch (error) {
      // Req 4.5: the client dropped right as we sent the completion event.
      // Persist the fully-received prefix as a disconnect.
      return this.settlePartial({
        ctx,
        sink,
        text,
        usage,
        model,
        finishReason,
        eventCount,
        reason: 'disconnected',
        disconnected: true,
        cause: error,
      });
    }
    eventCount += 1;

    return {
      status: 'completed',
      text,
      usage,
      model,
      cost,
      eventCount,
      ...(finishReason !== undefined ? { finishReason } : {}),
      persisted: false,
    };
  }

  /**
   * Stop relaying and persist the received prefix for a cancel (Req 4.4) or a
   * disconnect (Req 4.5), then build the terminal {@link StreamResult}.
   */
  private async settlePartial(args: {
    ctx: StreamContext;
    sink: EventSink;
    text: string;
    usage: TokenUsage;
    model: string;
    finishReason: ChatFinishReason | undefined;
    eventCount: number;
    reason: 'cancelled' | 'disconnected';
    disconnected?: boolean;
    cause?: unknown;
  }): Promise<StreamResult> {
    const { ctx, text, usage, model, finishReason, eventCount, reason } = args;

    const partial: PartialResponse = {
      target: ctx.target,
      text,
      usage: { ...usage },
      reason,
      ...(model !== '' ? { model } : {}),
    };
    await this.persister.persist(partial);

    const cost = computeStreamCost(ctx.cost, usage);
    return {
      status: reason,
      text,
      usage,
      model,
      cost,
      eventCount,
      ...(finishReason !== undefined ? { finishReason } : {}),
      persisted: true,
    };
  }
}

/**
 * Compute the total message cost from a {@link CostSource} and the final usage
 * (Req 4.3).
 *
 * Mirrors the Model_Router's `computeCost` for the {@link ModelCost} form:
 * `inputTokens/1000 * per1kInputTokens + outputTokens/1000 * per1kOutputTokens`.
 * A `number` source is a precomputed total returned verbatim; a function source
 * is applied to the usage.
 *
 * @param source The precomputed cost, per-1k model costs, or a cost function.
 * @param usage The final (or partial) token usage to price.
 * @returns The total cost in the platform's accounting currency.
 */
export function computeStreamCost(source: CostSource, usage: TokenUsage): number {
  if (typeof source === 'number') {
    return source;
  }
  if (typeof source === 'function') {
    return source(usage);
  }
  const cost: ModelCost = source;
  return (
    (usage.inputTokens / 1000) * cost.per1kInputTokens +
    (usage.outputTokens / 1000) * cost.per1kOutputTokens
  );
}

/**
 * Best-effort close of an async iterator's `return`, swallowing any error.
 *
 * Called when the engine stops consuming the source early (cancel, disconnect,
 * or source error) so a generator's `finally` runs and provider resources are
 * released; a throwing `return` must not mask the original outcome.
 */
async function closeIterator(iterator: AsyncIterator<ProviderChunk>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Ignore: cleanup failure must not override the stream's settled outcome.
  }
}
