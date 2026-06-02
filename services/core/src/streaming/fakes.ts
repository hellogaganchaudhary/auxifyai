/**
 * Test fakes and builders for the Streaming_Engine (tasks 8.5, 8.6).
 *
 * The Streaming_Engine has exactly three effectful collaborators — the
 * {@link EventSink} it relays to, the {@link PartialResponsePersister} it
 * persists prefixes through, and the source chunk stream it consumes. These
 * fakes model all three deterministically so cancellation (Req 4.4) and client
 * disconnect (Req 4.5) are simulated *without* any real SSE, WebSocket, timers,
 * or network:
 *
 *   - {@link RecordingEventSink} captures every emitted {@link StreamEvent} and
 *     can be configured to throw on the Nth `emit` to simulate a client
 *     disconnect mid-stream (Req 4.5).
 *   - {@link CapturingPartialResponsePersister} records every persisted
 *     {@link PartialResponse} so a test can assert the received prefix, usage,
 *     model, and reason were persisted (Req 4.4, 4.5).
 *   - {@link chunksFromDeltas} / {@link streamFromChunks} build a provider
 *     {@link ProviderChunk} source from plain token strings, optionally invoking
 *     a hook before each chunk so a test can `abort()` an
 *     {@link AbortController} at a precise point (a deterministic user cancel,
 *     Req 4.4).
 */

import type { ChatChunk, ChatFinishReason, TokenUsage } from '@auxify/types';

import type { ProviderChunk } from './streaming-engine.js';
import type { EventSink, PartialResponse, PartialResponsePersister, StreamEvent } from './types.js';

/**
 * A recording {@link EventSink} that captures every emitted event and can
 * simulate a client disconnect.
 *
 * By default it records all events and never fails. Pass `throwOnEmitCall: n`
 * to make the `n`-th `emit` (1-based) throw a {@link FakeDisconnectError},
 * modeling the transport dropping mid-stream (Req 4.5); the engine then stops
 * relaying and persists the received prefix. Events recorded in {@link events}
 * are exactly those the engine successfully delivered (the failed emit is not
 * recorded), so a test can assert what reached the client before the drop.
 */
export class RecordingEventSink implements EventSink {
  /** Every event successfully emitted, in order. */
  readonly events: StreamEvent[] = [];
  /** The total number of `emit` calls, including one that throws. */
  emitCalls = 0;

  constructor(private readonly options: { throwOnEmitCall?: number } = {}) {}

  emit(event: StreamEvent): void {
    this.emitCalls += 1;
    if (this.options.throwOnEmitCall === this.emitCalls) {
      throw new FakeDisconnectError(this.emitCalls);
    }
    this.events.push(event);
  }

  /** Every emitted token event, in order. */
  get tokenEvents(): Extract<StreamEvent, { type: 'token' }>[] {
    return this.events.filter(
      (e): e is Extract<StreamEvent, { type: 'token' }> => e.type === 'token',
    );
  }

  /** The single completion event, or `undefined` when none was emitted. */
  get completion(): Extract<StreamEvent, { type: 'completion' }> | undefined {
    return this.events.find(
      (e): e is Extract<StreamEvent, { type: 'completion' }> => e.type === 'completion',
    );
  }

  /** The concatenation of every emitted token delta (the delivered prefix). */
  get deliveredText(): string {
    return this.tokenEvents.map((e) => e.delta).join('');
  }
}

/** The error a {@link RecordingEventSink} throws to simulate a dropped client connection (Req 4.5). */
export class FakeDisconnectError extends Error {
  constructor(readonly emitCall: number) {
    super(`fake client disconnect on emit #${emitCall}`);
    this.name = 'FakeDisconnectError';
  }
}

/**
 * A capturing {@link PartialResponsePersister} that records every persisted
 * partial response so a test can assert the received prefix, usage, model, and
 * reason were persisted on cancel (Req 4.4) or disconnect (Req 4.5).
 */
export class CapturingPartialResponsePersister implements PartialResponsePersister {
  /** Every persisted partial response, in order. */
  readonly persisted: PartialResponse[] = [];

  persist(partial: PartialResponse): void {
    // Defensive copy so later mutation by callers cannot rewrite history.
    this.persisted.push({ ...partial, usage: { ...partial.usage }, target: { ...partial.target } });
  }

  /** The most recently persisted partial response, or `undefined` when none. */
  get last(): PartialResponse | undefined {
    return this.persisted[this.persisted.length - 1];
  }
}

/** A spec for one provider chunk used by {@link streamFromChunks}. */
export interface ChunkSpec {
  /** The incremental token text (use `''` for a terminal usage-only chunk). */
  delta: string;
  /** Marks the terminal chunk. */
  done?: boolean;
  /** The model id, typically set on the terminal chunk. */
  model?: string;
  /** Cumulative usage, typically set on the terminal chunk. */
  usage?: TokenUsage;
  /** The finish reason, typically set on the terminal chunk. */
  finishReason?: ChatFinishReason;
}

/**
 * Build a provider chunk list from plain token strings plus a terminal
 * usage/model/finish chunk.
 *
 * Produces one `{ delta }` chunk per token, then a terminal
 * `{ delta: '', done: true, model, usage, finishReason }` chunk — exactly the
 * shape providers emit (Req 4.2, 4.3), so tests describe a stream by its tokens
 * alone.
 *
 * @param deltas The token strings to stream, in order.
 * @param terminal The terminal chunk's model, usage, and finish reason.
 */
export function chunksFromDeltas(
  deltas: string[],
  terminal: { model: string; usage: TokenUsage; finishReason?: ChatFinishReason },
): ChunkSpec[] {
  const tokens: ChunkSpec[] = deltas.map((delta) => ({ delta }));
  tokens.push({
    delta: '',
    done: true,
    model: terminal.model,
    usage: terminal.usage,
    finishReason: terminal.finishReason ?? 'stop',
  });
  return tokens;
}

/**
 * Turn a list of {@link ChunkSpec}s into an async iterable provider source.
 *
 * Before yielding each chunk it invokes the optional `beforeChunk(index)` hook,
 * letting a test fire a side effect — most importantly `abortController.abort()`
 * — at a precise position to simulate a deterministic user cancel mid-stream
 * (Req 4.4), with no timers. The generator's `finally` records that it was
 * closed, so a test can assert the engine released the source on early stop.
 *
 * @param chunks The chunks to yield, in order.
 * @param hooks Optional `beforeChunk` side effect and a `closed` flag holder.
 */
export function streamFromChunks(
  chunks: ChunkSpec[],
  hooks: { beforeChunk?: (index: number) => void | Promise<void>; onClose?: () => void } = {},
): AsyncIterable<ProviderChunk> {
  async function* generate(): AsyncGenerator<ProviderChunk> {
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (hooks.beforeChunk !== undefined) {
          await hooks.beforeChunk(index);
        }
        const spec = chunks[index];
        if (spec === undefined) {
          continue;
        }
        const chunk: ChatChunk = { delta: spec.delta };
        if (spec.done !== undefined) {
          chunk.done = spec.done;
        }
        if (spec.model !== undefined) {
          chunk.model = spec.model;
        }
        if (spec.usage !== undefined) {
          chunk.usage = spec.usage;
        }
        if (spec.finishReason !== undefined) {
          chunk.finishReason = spec.finishReason;
        }
        yield chunk;
      }
    } finally {
      hooks.onClose?.();
    }
  }
  return generate();
}

/**
 * An async source that yields the given chunks and then throws — models a
 * provider/source stream that fails mid-flight (distinct from a client
 * disconnect). The engine re-raises rather than persisting, leaving fallback to
 * the Model_Router.
 *
 * @param deltas Token deltas to yield before failing.
 * @param error The error to throw after the last delta.
 */
export function failingStream(deltas: string[], error: Error): AsyncIterable<ProviderChunk> {
  async function* generate(): AsyncGenerator<ProviderChunk> {
    for (const delta of deltas) {
      yield { delta };
    }
    throw error;
  }
  return generate();
}
