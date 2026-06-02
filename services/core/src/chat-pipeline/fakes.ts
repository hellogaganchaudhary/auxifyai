/**
 * Test wiring helpers for the Chat_Pipeline.
 *
 * The Chat_Pipeline is a pure COMPOSITION of the real request-path services, so
 * its tests assemble the REAL services over each component module's OWN
 * in-memory fakes (imported directly from each module's `./fakes.js`) and drive
 * the assembled pipeline end to end. This module adds only the few helpers that
 * are specific to the composition itself and have no component-module home:
 *
 *   - {@link CapturingEventSink} — a recording {@link EventSink} the
 *     Streaming_Engine relays into, so a test can assert the exact ordered token
 *     events and the single completion event (carrying model + tokens + cost)
 *     reached the client (Req 4.1, 4.3). (The streaming module's own
 *     `RecordingEventSink` can simulate a disconnect; this minimal sink is for
 *     the happy path and is deliberately collision-free.)
 *   - {@link NoopPartialResponsePersister} — a no-op
 *     {@link PartialResponsePersister} for constructing a {@link StreamingEngine}
 *     in a pipeline whose tests do not exercise cancel/disconnect.
 *   - {@link makeKnowledgeChunkRecord} — builds a `knowledge_chunk`
 *     {@link VectorRecord} (1536-dim, fully attributed) so a test can seed the
 *     shared {@link InMemoryVectorStore} the real {@link RagRetriever} reads
 *     (Req 24.1, 24.4, 44.2).
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 */

import type { SourceAttribution } from '@auxify/types';

import { EMBEDDING_DIMENSIONS, type VectorRecord } from '../storage/index.js';
import type {
  CompletionStreamEvent,
  EventSink,
  PartialResponse,
  PartialResponsePersister,
  StreamEvent,
  TokenStreamEvent,
} from '../streaming/index.js';

/**
 * A recording {@link EventSink} capturing every event the Streaming_Engine
 * relays, so a test can assert the ordered token events and the single
 * completion event reached the client (Req 4.1, 4.3).
 */
export class CapturingEventSink implements EventSink {
  /** Every event emitted, in order. */
  readonly events: StreamEvent[] = [];

  emit(event: StreamEvent): void {
    this.events.push(event);
  }

  /** Every emitted token event, in order (Req 4.1). */
  get tokenEvents(): TokenStreamEvent[] {
    return this.events.filter((e): e is TokenStreamEvent => e.type === 'token');
  }

  /** The single completion event, or `undefined` when none was emitted (Req 4.3). */
  get completion(): CompletionStreamEvent | undefined {
    return this.events.find((e): e is CompletionStreamEvent => e.type === 'completion');
  }

  /** The concatenation of every emitted token delta (the delivered prefix). */
  get deliveredText(): string {
    return this.tokenEvents.map((e) => e.delta).join('');
  }
}

/**
 * A no-op {@link PartialResponsePersister} for constructing a
 * {@link import('../streaming/index.js').StreamingEngine} in pipeline tests that
 * do not exercise the cancel/disconnect prefix-persistence path.
 */
export class NoopPartialResponsePersister implements PartialResponsePersister {
  persist(_partial: PartialResponse): void {
    // Intentionally empty: the happy-path pipeline never persists a prefix.
  }
}

/**
 * Build a complete {@link SourceAttribution} with sensible defaults; override
 * field-by-field. A complete attribution is required for a chunk to survive the
 * RAG_Retriever's attribution gate (Req 24.6).
 */
export function makeSourceAttribution(
  overrides: Partial<SourceAttribution> = {},
): SourceAttribution {
  return {
    sourceId: 'src-1',
    sourceTitle: 'Onboarding Guide',
    location: 'page 1',
    link: 'https://kb.example/onboarding#1',
    ...overrides,
  };
}

/**
 * Build a `knowledge_chunk` {@link VectorRecord} the real {@link RagRetriever}
 * can retrieve and attribute (Req 24.1, 24.4, 44.2).
 *
 * The embedding fills all {@link EMBEDDING_DIMENSIONS} dimensions with `seed`
 * (default `1`) so a query embedded to the same constant scores maximally
 * similar in the {@link InMemoryVectorStore}; the chunk's metadata carries the
 * `sourceId` / `documentId` / `ordinal` / `text` / complete `attribution` the
 * retriever reads back.
 */
export function makeKnowledgeChunkRecord(options: {
  id: string;
  organizationId: string;
  text: string;
  attribution?: SourceAttribution;
  sourceId?: string;
  documentId?: string;
  ordinal?: number;
  seed?: number;
}): VectorRecord {
  const attribution = options.attribution ?? makeSourceAttribution();
  const sourceId = options.sourceId ?? attribution.sourceId;
  return {
    id: options.id,
    organizationId: options.organizationId,
    ownerType: 'knowledge_chunk',
    ownerId: options.id,
    embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(options.seed ?? 1),
    metadata: {
      sourceId,
      documentId: options.documentId ?? 'kdoc-1',
      ordinal: options.ordinal ?? 0,
      text: options.text,
      attribution,
    },
  };
}
