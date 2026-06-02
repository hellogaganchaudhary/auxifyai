/**
 * Test fakes and builders for the native-ingestion wiring (Req 26.8, 27.9, 28.5,
 * 29.1).
 *
 * The wiring is pure composition over the component modules, so its tests mostly
 * reuse the component modules' own in-memory fakes — imported directly here and
 * re-exported under module-qualified aliases so a test assembles a real
 * Knowledge_Hub_Service / Messaging_Service / Document_Management_Service over a
 * real {@link import('../knowledge/index.js').KnowledgeIngestionService} without
 * touching a database, an object store, an embedding model, or a network:
 *
 *   - the Knowledge_Ingestion_Service's {@link InMemoryKnowledgeStore} and the
 *     File_Processor's {@link DeterministicEmbedder}, plus the shared
 *     {@link InMemoryVectorStore} / {@link InMemoryObjectStore}, back the real
 *     ingestion + retrieval path (re-exported here for convenience);
 *   - each native module's in-memory store + allow-all authorizer + capturing
 *     audit recorder + principal builder (imported by the tests directly from
 *     `../knowledge-hub/fakes.js`, `../messaging/fakes.js`, and
 *     `../document-management/fakes.js`) assemble the real module services.
 *
 * The only wiring-specific double is {@link CapturingIngestionFailureRecorder},
 * which records every {@link NativeIngestionFailure} so a test can assert the
 * resilience contract (an indexing failure is recorded, never thrown back to the
 * originating write — Req 23.8).
 *
 * These are imported directly from `./fakes.js` by the tests (never from the
 * package barrel), matching the established convention.
 */

import { DeterministicEmbedder } from '../file-processor/fakes.js';
import { InMemoryKnowledgeStore } from '../knowledge/fakes.js';
import { InMemoryObjectStore, InMemoryVectorStore } from '../storage/index.js';

import type { IngestionFailureRecorder, NativeIngestionFailure } from './types.js';

/** Re-export the shared knowledge-ingestion + storage + embedder fakes used to back the real path. */
export { DeterministicEmbedder, InMemoryKnowledgeStore, InMemoryObjectStore, InMemoryVectorStore };

/**
 * A capturing {@link IngestionFailureRecorder} storing every recorded failure so
 * a test can assert the resilience contract (Req 23.8): a forward that fails is
 * recorded here rather than thrown back to the originating module write.
 */
export class CapturingIngestionFailureRecorder implements IngestionFailureRecorder {
  /** Every recorded failure, in order. */
  readonly failures: NativeIngestionFailure[] = [];

  record(failure: NativeIngestionFailure): void {
    this.failures.push({ ...failure });
  }

  /** The number of failures recorded so far. */
  get count(): number {
    return this.failures.length;
  }

  /** Every recorded failure for the given native content type. */
  forType(type: NativeIngestionFailure['type']): NativeIngestionFailure[] {
    return this.failures.filter((f) => f.type === type);
  }

  /** The single most recently recorded failure, or `undefined` if none. */
  get last(): NativeIngestionFailure | undefined {
    return this.failures[this.failures.length - 1];
  }
}
