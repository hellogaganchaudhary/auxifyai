/**
 * Feature: auxify-ai-platform, Property 16: Streaming cancellation and
 * disconnection preserve the received prefix.
 *
 * Validates: Requirements 4.4, 4.5
 *
 * _For any_ arbitrary token sequence and _any_ cut point `k`, stopping the
 * {@link StreamingEngine} early — whether by a user cancel (Req 4.4) or a client
 * disconnect (Req 4.5) — persists EXACTLY the prefix of tokens received so far:
 * the accumulated/persisted text equals `deltas[0..k).join('')`, which is always
 * an in-order prefix of the full stream `deltas.join('')` (never more than was
 * received, never reordered), and no completion event is emitted after the stop.
 *
 *   - **CANCEL at k.** Aborting the injected {@link AbortSignal} just before the
 *     engine pulls token `k` (via {@link streamFromChunks}'s deterministic
 *     `beforeChunk` hook firing `AbortController.abort()`) lets exactly the first
 *     `k` tokens reach the client, then stops. `status === 'cancelled'`, the
 *     received prefix `deltas[0..k)` is persisted, and the delivered text equals
 *     that same prefix (every received token was also delivered).
 *   - **DISCONNECT at k.** Configuring {@link RecordingEventSink} to throw on the
 *     `k`-th `emit` drops the connection while delivering token `k`. The engine
 *     accumulates a token's text *before* emitting it, so the received prefix is
 *     `deltas[0..k)` (it includes the token whose `emit` failed — the token was
 *     generated before the drop, Req 4.5), while only `deltas[0..k-1)` was
 *     actually delivered. `status === 'disconnected'` and the received prefix is
 *     persisted.
 *   - **CONTROL (no stop).** With neither a cancel nor a disconnect the stream
 *     runs to completion: `status === 'completed'`, the full text is accumulated,
 *     a single completion event is emitted, and nothing is persisted.
 *
 * The property drives the REAL {@link StreamingEngine} against the same
 * deterministic fakes the unit suite uses ({@link RecordingEventSink},
 * {@link CapturingPartialResponsePersister}, {@link chunksFromDeltas},
 * {@link streamFromChunks}) plus an {@link AbortController} — no real SSE,
 * WebSocket, timers, or network. Token deltas are generated NON-EMPTY so the
 * cut point `k` maps one-to-one onto token events and `emit` calls, making the
 * preserved prefix exact (the engine's separate empty/usage-only delta filtering
 * is covered by `streaming-engine.test.ts`).
 */

import type { TokenUsage } from '@auxify/types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CapturingPartialResponsePersister,
  RecordingEventSink,
  chunksFromDeltas,
  streamFromChunks,
} from './fakes.js';
import { StreamingEngine } from './streaming-engine.js';
import type { StreamContext } from './types.js';

/** Minimum generated iterations for the property (>= 100). */
const NUM_RUNS = 200;

const TARGET = { conversationId: 'conv-1', messageId: 'msg-1' } as const;

/** The terminal usage/model the source reports once the stream completes. */
const TERMINAL = {
  model: 'stream-model',
  usage: { inputTokens: 3, outputTokens: 5 } satisfies TokenUsage,
  finishReason: 'stop' as const,
};

/** A fresh engine plus the capturing persister it writes prefixes through. */
function makeEngine(): {
  engine: StreamingEngine;
  persister: CapturingPartialResponsePersister;
} {
  const persister = new CapturingPartialResponsePersister();
  return { engine: new StreamingEngine({ persister }), persister };
}

/** A StreamContext with a per-1k cost source; `signal` supplied only on cancel. */
function makeContext(signal?: AbortSignal): StreamContext {
  return {
    target: TARGET,
    cost: { per1kInputTokens: 2, per1kOutputTokens: 4 },
    modelId: TERMINAL.model,
    ...(signal !== undefined ? { signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Generators: an arbitrary NON-EMPTY token sequence, a stop mode, and a cut
// point k whose valid range depends on the mode.
// ---------------------------------------------------------------------------

type StopMode = 'cancel' | 'disconnect';

/**
 * An arbitrary token sequence, a stop mode, and a cut point `k`:
 *   - `cancel`: k in [0, len] — abort before the engine pulls token k, so the
 *     first k tokens are delivered (k = 0 aborts before any token; k = len
 *     aborts after the last token, before the completion event).
 *   - `disconnect`: k in [1, len] — the k-th `emit` throws, so the received
 *     prefix is the first k tokens (the k-th is generated but not delivered).
 */
const stopScenarioArb = fc
  .array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 })
  .chain((deltas) =>
    fc.constantFrom<StopMode>('cancel', 'disconnect').chain((mode) =>
      fc.record({
        deltas: fc.constant(deltas),
        mode: fc.constant(mode),
        k:
          mode === 'cancel'
            ? fc.integer({ min: 0, max: deltas.length })
            : fc.integer({ min: 1, max: deltas.length }),
      }),
    ),
  );

/** Control scenario: just an arbitrary non-empty token sequence (runs to completion). */
const completeScenarioArb = fc.array(fc.string({ minLength: 1, maxLength: 6 }), {
  minLength: 0,
  maxLength: 8,
});

// ---------------------------------------------------------------------------
// Property 16.
// ---------------------------------------------------------------------------

describe('Feature: auxify-ai-platform, Property 16: Streaming cancellation and disconnection preserve the received prefix', () => {
  it('persists EXACTLY the received in-order prefix on user cancel and client disconnect, with no completion event (Validates: Requirements 4.4, 4.5)', async () => {
    await fc.assert(
      fc.asyncProperty(stopScenarioArb, async ({ deltas, mode, k }) => {
        const { engine, persister } = makeEngine();
        const full = deltas.join('');
        const expectedPrefix = deltas.slice(0, k).join('');

        let result;
        let sink: RecordingEventSink;
        if (mode === 'cancel') {
          // Deterministic user cancel: abort right before the engine pulls
          // token k, so exactly the first k tokens are delivered (Req 4.4).
          const controller = new AbortController();
          sink = new RecordingEventSink();
          const source = streamFromChunks(chunksFromDeltas(deltas, TERMINAL), {
            beforeChunk: (index) => {
              if (index === k) {
                controller.abort();
              }
            },
          });

          result = await engine.stream(source, sink, makeContext(controller.signal));

          expect(result.status).toBe('cancelled');
          // Everything received was also delivered (cancel happens between tokens).
          expect(sink.deliveredText).toBe(expectedPrefix);
          expect(persister.last?.reason).toBe('cancelled');
        } else {
          // Deterministic client disconnect: the k-th emit throws, dropping the
          // connection while delivering token k (Req 4.5).
          sink = new RecordingEventSink({ throwOnEmitCall: k });
          const source = streamFromChunks(chunksFromDeltas(deltas, TERMINAL));

          result = await engine.stream(source, sink, makeContext());

          expect(result.status).toBe('disconnected');
          // The k-th token was generated (accumulated) but its emit failed, so
          // only the first k-1 tokens were actually delivered.
          expect(sink.deliveredText).toBe(deltas.slice(0, k - 1).join(''));
          expect(persister.last?.reason).toBe('disconnected');
        }

        // --- The shared prefix-preservation invariant (Req 4.4, 4.5) --------
        // The accumulated text is EXACTLY the received prefix deltas[0..k).
        expect(result.text).toBe(expectedPrefix);
        // It is an in-order prefix of the full stream: never more than was
        // received, never reordered.
        expect(full.startsWith(expectedPrefix)).toBe(true);
        expect(expectedPrefix.length).toBeLessThanOrEqual(full.length);

        // The received prefix was persisted exactly once, against the target.
        expect(result.persisted).toBe(true);
        expect(persister.persisted).toHaveLength(1);
        expect(persister.last?.text).toBe(expectedPrefix);
        expect(persister.last?.target).toEqual(TARGET);

        // No completion event is ever emitted once the stream is stopped early.
        expect(sink.completion).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('control: with no cancel or disconnect the stream completes, accumulates the full text, and persists nothing (Validates: Requirements 4.4, 4.5)', async () => {
    await fc.assert(
      fc.asyncProperty(completeScenarioArb, async (deltas) => {
        const { engine, persister } = makeEngine();
        const sink = new RecordingEventSink();
        const source = streamFromChunks(chunksFromDeltas(deltas, TERMINAL));

        const result = await engine.stream(source, sink, makeContext());

        const full = deltas.join('');
        expect(result.status).toBe('completed');
        expect(result.text).toBe(full);
        expect(sink.deliveredText).toBe(full);

        // Exactly one completion event, emitted after every token event.
        expect(sink.completion).toBeDefined();
        expect(sink.completion?.model).toBe(TERMINAL.model);
        expect(result.eventCount).toBe(deltas.length + 1);

        // A clean completion persists no partial response.
        expect(result.persisted).toBe(false);
        expect(persister.persisted).toHaveLength(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
