/**
 * Stable, backend-agnostic storage interfaces (the "replaceable provider
 * abstractions" boundary for the Data Layer).
 *
 * These three interfaces are the only storage contracts the rest of the
 * platform depends on. Concrete backends (pgvector, S3/MinIO, Redis) implement
 * them and can be swapped without touching consumers (Req 44.3).
 */

import type {
  VectorFilter,
  VectorMatch,
  VectorRecord,
} from './types.js';

/**
 * Vector_Store — persists 1536-dimensional embeddings, indexed with HNSW, for
 * knowledge chunks, file chunks, knowledge pages, documents, and messaging
 * content (Req 44.2). Designed to permit migration to an alternate vector
 * backend without redesigning the embedding schema or consumers (Req 44.3).
 */
export interface VectorStore {
  /**
   * Insert or replace vector records (keyed by {@link VectorRecord.id}).
   *
   * The call is rejected — and persists nothing — unless every record's
   * embedding has exactly 1536 dimensions (Req 44.2). On success, all records
   * in the batch are upserted.
   */
  upsert(records: VectorRecord[]): Promise<void>;

  /**
   * Return up to `k` records most similar to `embedding`, restricted by
   * `filter` (always organization-scoped), ordered most-similar first.
   */
  query(embedding: number[], filter: VectorFilter, k: number): Promise<VectorMatch[]>;

  /** Delete records by id. Unknown ids are ignored. */
  delete(ids: string[]): Promise<void>;
}

/**
 * Object_Store — persists uploaded files, managed documents, generated assets,
 * and backups (Req 44.5). Backed by S3 (AWS) / Blob Storage (Azure) /
 * MinIO (local), behind this stable key→bytes interface.
 */
export interface ObjectStore {
  /** Store `data` under `key`, replacing any existing object at that key. */
  put(key: string, data: Uint8Array, options?: PutObjectOptions): Promise<void>;

  /** Retrieve the bytes stored at `key`. Throws {@link ObjectNotFoundError} if absent. */
  get(key: string): Promise<Uint8Array>;

  /** Delete the object at `key`. Deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;

  /** True iff an object exists at `key`. */
  exists(key: string): Promise<boolean>;
}

/** Optional metadata supplied when writing an object. */
export interface PutObjectOptions {
  /** MIME type recorded with the object (e.g. `application/pdf`). */
  contentType?: string;
  /** Arbitrary user metadata stored alongside the object. */
  metadata?: Record<string, string>;
}

/**
 * Cache_Store — holds cached search results, cached scraped pages, session
 * data, real-time events, and background job state (Req 44.4). Backed by Redis,
 * behind this stable key→value interface with TTL support.
 */
export interface CacheStore {
  /** Return the value stored at `key`, or `null` if missing or expired. */
  get<T = unknown>(key: string): Promise<T | null>;

  /**
   * Store `value` at `key`. When `ttlSeconds` is provided and positive, the
   * entry expires after that many seconds; otherwise it persists until deleted.
   */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;

  /** Delete the entry at `key`. Deleting a missing key is a no-op. */
  delete(key: string): Promise<void>;

  /** True iff a live (non-expired) entry exists at `key`. */
  has(key: string): Promise<boolean>;
}

/** Thrown by {@link ObjectStore.get} when no object exists at the given key. */
export class ObjectNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`No object found at key "${key}".`);
    this.name = 'ObjectNotFoundError';
  }
}
