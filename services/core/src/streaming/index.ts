/**
 * Streaming_Engine (Req 4.1-4.5).
 *
 * The transport-agnostic relay that delivers a model response to a client
 * token-by-token over SSE or WebSocket (Req 4.1, 4.2), emits a completion event
 * carrying the model, total token counts, and total cost (Req 4.3), and — on a
 * user cancel (Req 4.4) or a client disconnect (Req 4.5) — stops and persists
 * the received prefix.
 *
 * Surface:
 *   - {@link StreamingEngine} — the engine; `stream(source, sink, ctx)` relays
 *     a provider chunk stream and returns a {@link StreamResult}.
 *   - {@link computeStreamCost} — the per-1k/precomputed/function cost helper
 *     used for the completion event (Req 4.3), mirroring the router's cost shape.
 *   - {@link EventSink} — the transport port an SSE/WebSocket adapter implements.
 *   - {@link PartialResponsePersister} / {@link PartialResponse} — the
 *     Chat_Service persistence hook for the prefix on cancel/disconnect.
 *   - {@link StreamContext} / {@link StreamResult} / {@link StreamStatus} —
 *     the per-request input and settled-outcome shapes.
 *   - {@link StreamEvent} / {@link TokenStreamEvent} / {@link CompletionStreamEvent}
 *     — the events delivered to the client.
 *   - {@link CostSource} / {@link CostFn} / {@link PersistenceTarget} /
 *     {@link PartialResponseReason} / {@link ProviderChunk} — supporting types.
 */

export {
  StreamingEngine,
  computeStreamCost,
  type ProviderChunk,
  type StreamingEngineOptions,
} from './streaming-engine.js';

export type {
  CompletionStreamEvent,
  CostFn,
  CostSource,
  EventSink,
  PartialResponse,
  PartialResponsePersister,
  PartialResponseReason,
  PersistenceTarget,
  StreamContext,
  StreamEvent,
  StreamResult,
  StreamStatus,
  TokenStreamEvent,
} from './types.js';
