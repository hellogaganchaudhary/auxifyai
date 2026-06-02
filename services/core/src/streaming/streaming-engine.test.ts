/**
 * Unit tests for the Streaming_Engine (Req 4.1-4.5).
 *
 * These exercise {@link StreamingEngine.stream} and {@link computeStreamCost}
 * against deterministic fakes ({@link RecordingEventSink},
 * {@link CapturingPartialResponsePersister}, {@link streamFromChunks}) and an
 * {@link AbortController}, with no real SSE/WebSocket, timers, or network,
 * covering:
 *   - incremental token emission, one event per delta, before completion
 *     (Req 4.1, 4.2),
 *   - a single completion event carrying model, total tokens, and cost (Req 4.3),
 *   - user cancel stops transmission and persists the received prefix (Req 4.4),
 *   - client disconnect persists the prefix generated before the drop (Req 4.5),
 *   - the cost helper across precomputed/per-1k/function sources (Req 4.3).
 */

import type { TokenUsage } from '@auxify/types';
import { describe, expect, it } from 'vitest';

import {
  CapturingPartialResponsePersister,
  RecordingEventSink,
  chunksFromDeltas,
  failingStream,
  streamFromChunks,
} from './fakes.js';
import { StreamingEngine, computeStreamCost } from './streaming-engine.js';
import type { StreamContext } from './types.js';

const TARGET = { conversationId: 'conv-1', messageId: 'msg-1' } as const;

/** Build a StreamingEngine plus its capturing persister. */
function makeEngine(): {
  engine: StreamingEngine;
  persister: CapturingPartialResponsePersister;
} {
  const persister = new CapturingPartialResponsePersister();
  return { engine: new StreamingEngine({ persister }), persister };
}

/** Build a StreamContext with a per-1k cost source by default. */
function makeContext(overrides: Partial<StreamContext> = {}): StreamContext {
  return {
    target: TARGET,
    cost: { per1kInputTokens: 2, per1kOutputTokens: 4 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeStreamCost (Req 4.3).
// ---------------------------------------------------------------------------

describe('computeStreamCost (Req 4.3)', () => {
  const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };

  it('returns a precomputed number cost verbatim', () => {
    expect(computeStreamCost(3.5, usage)).toBe(3.5);
  });

  it('computes from per-1k model costs like the router', () => {
    // 1000/1000*2 + 500/1000*4 = 2 + 2 = 4
    expect(computeStreamCost({ per1kInputTokens: 2, per1kOutputTokens: 4 }, usage)).toBeCloseTo(
      4,
      10,
    );
  });

  it('applies a custom cost function to the usage', () => {
    expect(computeStreamCost((u) => u.inputTokens + u.outputTokens, usage)).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// Incremental token emission (Req 4.1, 4.2).
// ---------------------------------------------------------------------------

describe('StreamingEngine.stream — incremental delivery (Req 4.1, 4.2)', () => {
  it('emits one token event per delta, in order, before completion', async () => {
    const { engine } = makeEngine();
    const sink = new RecordingEventSink();
    const source = streamFromChunks(
      chunksFromDeltas(['Hel', 'lo', ' wo', 'rld'], {
        model: 'gpt-4o',
        usage: { inputTokens: 10, outputTokens: 4 },
      }),
    );

    const result = await engine.stream(source, sink, makeContext());

    // One token event per non-empty delta, in order, each with its index.
    expect(sink.tokenEvents).toEqual([
      { type: 'token', delta: 'Hel', index: 0 },
      { type: 'token', delta: 'lo', index: 1 },
      { type: 'token', delta: ' wo', index: 2 },
      { type: 'token', delta: 'rld', index: 3 },
    ]);
    expect(sink.deliveredText).toBe('Hello world');
    expect(result.status).toBe('completed');
    expect(result.text).toBe('Hello world');
  });

  it('emits token events before the completion event (ordering)', async () => {
    const { engine } = makeEngine();
    const sink = new RecordingEventSink();
    const source = streamFromChunks(
      chunksFromDeltas(['a', 'b'], { model: 'm', usage: { inputTokens: 1, outputTokens: 2 } }),
    );

    await engine.stream(source, sink, makeContext());

    const types = sink.events.map((e) => e.type);
    expect(types).toEqual(['token', 'token', 'completion']);
  });

  it('does not emit a token event for an empty (usage-only) delta', async () => {
    const { engine } = makeEngine();
    const sink = new RecordingEventSink();
    // Terminal chunk has delta '' — it must not become a token event.
    const source = streamFromChunks(
      chunksFromDeltas(['only'], { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
    );

    await engine.stream(source, sink, makeContext());

    expect(sink.tokenEvents).toHaveLength(1);
    expect(sink.tokenEvents[0]?.delta).toBe('only');
  });
});

// ---------------------------------------------------------------------------
// Completion event (Req 4.3).
// ---------------------------------------------------------------------------

describe('StreamingEngine.stream — completion event (Req 4.3)', () => {
  it('emits a completion event with model, total tokens, and cost', async () => {
    const { engine, persister } = makeEngine();
    const sink = new RecordingEventSink();
    const usage: TokenUsage = { inputTokens: 1000, outputTokens: 500 };
    const source = streamFromChunks(
      chunksFromDeltas(['x', 'y'], { model: 'gpt-4o', usage, finishReason: 'stop' }),
    );

    const result = await engine.stream(source, sink, makeContext());

    expect(sink.completion).toEqual({
      type: 'completion',
      model: 'gpt-4o',
      usage,
      // 1000/1000*2 + 500/1000*4 = 4
      cost: 4,
      finishReason: 'stop',
    });
    expect(result).toMatchObject({
      status: 'completed',
      model: 'gpt-4o',
      usage,
      cost: 4,
      finishReason: 'stop',
      persisted: false,
    });
    // Two token events + one completion event.
    expect(result.eventCount).toBe(3);
    // Nothing is persisted on a clean completion.
    expect(persister.persisted).toHaveLength(0);
  });

  it('uses a precomputed number cost for the completion event', async () => {
    const { engine } = makeEngine();
    const sink = new RecordingEventSink();
    const source = streamFromChunks(
      chunksFromDeltas(['a'], { model: 'm', usage: { inputTokens: 9, outputTokens: 9 } }),
    );

    const result = await engine.stream(source, sink, makeContext({ cost: 42 }));

    expect(sink.completion?.cost).toBe(42);
    expect(result.cost).toBe(42);
  });

  it('falls back to the context modelId when chunks omit a model', async () => {
    const { engine } = makeEngine();
    const sink = new RecordingEventSink();
    // No model on any chunk; ctx supplies it.
    const source = streamFromChunks([
      { delta: 'hi' },
      { delta: '', done: true, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
    ]);

    const result = await engine.stream(source, sink, makeContext({ modelId: 'claude-haiku' }));

    expect(sink.completion?.model).toBe('claude-haiku');
    expect(result.model).toBe('claude-haiku');
  });
});

// ---------------------------------------------------------------------------
// User cancel persists the received prefix (Req 4.4).
// ---------------------------------------------------------------------------

describe('StreamingEngine.stream — user cancel (Req 4.4)', () => {
  it('stops transmission and persists the prefix received before the cancel', async () => {
    const { engine, persister } = makeEngine();
    const sink = new RecordingEventSink();
    const controller = new AbortController();

    // Abort right before the 3rd chunk (index 2): tokens 0 and 1 are delivered,
    // then transmission stops — deterministic, no timers.
    const source = streamFromChunks(
      chunksFromDeltas(['one', 'two', 'three', 'four'], {
        model: 'gpt-4o',
        usage: { inputTokens: 5, outputTokens: 9 },
      }),
      {
        beforeChunk: (index) => {
          if (index === 2) {
            controller.abort();
          }
        },
      },
    );

    const result = await engine.stream(source, sink, makeContext({ signal: controller.signal }));

    // Only the first two tokens were transmitted before the cancel.
    expect(sink.deliveredText).toBe('onetwo');
    // No completion event on cancel.
    expect(sink.completion).toBeUndefined();

    // The received prefix was persisted (Req 4.4).
    expect(result.status).toBe('cancelled');
    expect(result.persisted).toBe(true);
    expect(persister.persisted).toHaveLength(1);
    expect(persister.last).toMatchObject({
      target: TARGET,
      text: 'onetwo',
      reason: 'cancelled',
    });
    expect(result.text).toBe('onetwo');
  });

  it('emits nothing and persists an empty prefix when already aborted', async () => {
    const { engine, persister } = makeEngine();
    const sink = new RecordingEventSink();
    const controller = new AbortController();
    controller.abort();

    const source = streamFromChunks(
      chunksFromDeltas(['a', 'b'], { model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
    );

    const result = await engine.stream(source, sink, makeContext({ signal: controller.signal }));

    expect(sink.events).toHaveLength(0);
    expect(result.status).toBe('cancelled');
    expect(result.text).toBe('');
    expect(persister.last).toMatchObject({ text: '', reason: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// Client disconnect persists the prefix generated before the drop (Req 4.5).
// ---------------------------------------------------------------------------

describe('StreamingEngine.stream — client disconnect (Req 4.5)', () => {
  it('persists the prefix generated before the sink disconnects mid-stream', async () => {
    const { engine, persister } = makeEngine();
    // The 3rd emit throws → tokens 0 and 1 reached the client, token 2 did not.
    const sink = new RecordingEventSink({ throwOnEmitCall: 3 });
    const source = streamFromChunks(
      chunksFromDeltas(['aa', 'bb', 'cc', 'dd'], {
        model: 'gpt-4o',
        usage: { inputTokens: 7, outputTokens: 11 },
      }),
    );

    const result = await engine.stream(source, sink, makeContext());

    // Two tokens were delivered before the drop.
    expect(sink.deliveredText).toBe('aabb');
    expect(result.status).toBe('disconnected');
    expect(result.persisted).toBe(true);
    // The accumulated prefix includes the token whose emit failed (it was generated).
    expect(result.text).toBe('aabbcc');
    expect(persister.last).toMatchObject({
      target: TARGET,
      text: 'aabbcc',
      reason: 'disconnected',
    });
    // No completion event was emitted on disconnect.
    expect(sink.completion).toBeUndefined();
  });

  it('persists as disconnected when the sink drops on the completion event', async () => {
    const { engine, persister } = makeEngine();
    // Two tokens succeed; the 3rd emit (the completion event) throws.
    const sink = new RecordingEventSink({ throwOnEmitCall: 3 });
    const source = streamFromChunks(
      chunksFromDeltas(['a', 'b'], { model: 'm', usage: { inputTokens: 1, outputTokens: 2 } }),
    );

    const result = await engine.stream(source, sink, makeContext());

    expect(result.status).toBe('disconnected');
    expect(result.text).toBe('ab');
    expect(persister.last).toMatchObject({ text: 'ab', reason: 'disconnected' });
    expect(sink.completion).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Source/provider errors are not the engine's domain.
// ---------------------------------------------------------------------------

describe('StreamingEngine.stream — source failure', () => {
  it('re-raises a source stream error without persisting (left to the router)', async () => {
    const { engine, persister } = makeEngine();
    const sink = new RecordingEventSink();
    const source = failingStream(['partial'], new Error('provider blew up'));

    await expect(engine.stream(source, sink, makeContext())).rejects.toThrow('provider blew up');
    // A provider/source error is the Model_Router's domain (fallback), not a
    // client cancel/disconnect — the engine persists nothing.
    expect(persister.persisted).toHaveLength(0);
  });
});
