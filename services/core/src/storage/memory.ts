/**
 * In-memory reference implementations of the storage interfaces.
 *
 * These backends are fully spec-compliant for their observable behavior —
 * including the 1536-dimension embedding invariant (Req 44.2) — and exist so
 * the storage contracts can be exercised in unit and property tests without a
 * running PostgreSQL/Redis/MinIO stack. Because they implement the exact same
 * interfaces as the production backends, they also demonstrate that consumers
 * are decoupled from any single backend (Req 44.3).
 */

import type { CacheStore, ObjectStore, VectorStore } from './interfaces.js';
import { ObjectNotFoundError } from './interfaces.js';
import {
  assertRecordsValid,
  type VectorFilter,
  type VectorMatch,
  type VectorOwnerType,
  type VectorRecord,
} from './types.js';

/** Cosine similarity of two equal-length vectors, mapped to `[0, 1]`. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  const cosine = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // Clamp into [-1, 1] (floating point can drift slightly), then map to [0, 1].
  const clamped = Math.max(-1, Math.min(1, cosine));
  return (clamped + 1) / 2;
}

function ownerTypeMatches(
  recordType: VectorOwnerType,
  filterType: VectorFilter['ownerType'],
): boolean {
  if (filterType === undefined) return true;
  return Array.isArray(filterType)
    ? filterType.includes(recordType)
    : filterType === recordType;
}

function metadataMatches(
  recordMeta: Record<string, unknown>,
  filterMeta: Record<string, unknown> | undefined,
): boolean {
  if (!filterMeta) return true;
  return Object.entries(filterMeta).every(
    ([key, value]) => recordMeta[key] === value,
  );
}

/**
 * In-memory {@link VectorStore}. Enforces the 1536-dimension invariant on
 * upsert and performs exact cosine-similarity search (the in-memory analogue of
 * pgvector's HNSW-approximated nearest neighbor).
 */
export class InMemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]): Promise<void> {
    // Validate the entire batch first so upsert is all-or-nothing (Req 44.2).
    assertRecordsValid(records);
    for (const record of records) {
      // Defensive copy so external mutation cannot corrupt stored state.
      this.records.set(record.id, {
        ...record,
        embedding: [...record.embedding],
        metadata: { ...record.metadata },
      });
    }
  }

  async query(
    embedding: number[],
    filter: VectorFilter,
    k: number,
  ): Promise<VectorMatch[]> {
    const matches: VectorMatch[] = [];
    for (const record of this.records.values()) {
      if (record.organizationId !== filter.organizationId) continue;
      if (!ownerTypeMatches(record.ownerType, filter.ownerType)) continue;
      if (filter.ownerId !== undefined && record.ownerId !== filter.ownerId) continue;
      if (!metadataMatches(record.metadata, filter.metadata)) continue;
      matches.push({
        id: record.id,
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        score: cosineSimilarity(embedding, record.embedding),
        metadata: { ...record.metadata },
      });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, Math.max(0, k));
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.records.delete(id);
    }
  }

  /** Test/inspection helper: number of stored records. */
  size(): number {
    return this.records.size;
  }
}

/** Internal representation of a stored object. */
interface StoredObject {
  data: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** In-memory {@link ObjectStore}. */
export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  async put(
    key: string,
    data: Uint8Array,
    options?: { contentType?: string; metadata?: Record<string, string> },
  ): Promise<void> {
    this.objects.set(key, {
      data: Uint8Array.from(data),
      contentType: options?.contentType,
      metadata: options?.metadata ? { ...options.metadata } : undefined,
    });
  }

  async get(key: string): Promise<Uint8Array> {
    const stored = this.objects.get(key);
    if (!stored) throw new ObjectNotFoundError(key);
    return Uint8Array.from(stored.data);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

/** Internal cache entry with optional absolute expiry timestamp (ms epoch). */
interface CacheEntry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * In-memory {@link CacheStore} with TTL semantics matching Redis: expired
 * entries are treated as absent and lazily evicted on access.
 */
export class InMemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private live(key: string): CacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.live(key);
    return entry ? (entry.value as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds !== undefined && ttlSeconds > 0
        ? this.now() + ttlSeconds * 1000
        : null;
    this.entries.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.live(key) !== null;
  }
}
