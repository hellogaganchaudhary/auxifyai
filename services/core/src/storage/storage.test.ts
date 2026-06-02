/**
 * Unit tests for the replaceable storage layer (Req 44.2–44.5).
 *
 * These cover specific examples and edge cases. The universally-quantified
 * property test for the 1536-dimension invariant (Property 56) lives in task
 * 2.2's dedicated property test.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIMENSIONS,
  InMemoryCacheStore,
  InMemoryObjectStore,
  InMemoryVectorStore,
  InvalidEmbeddingDimensionError,
  ObjectNotFoundError,
  PgVectorStore,
  RedisCacheStore,
  S3ObjectStore,
  assertEmbeddingDimensions,
  type RedisClientPort,
  type S3ClientPort,
  type SqlClient,
  type VectorRecord,
} from './index.js';

/** Build an embedding of the given dimensionality (default: the required size). */
function embedding(dims: number = EMBEDDING_DIMENSIONS, fill = 0.01): number[] {
  return Array.from({ length: dims }, () => fill);
}

function record(overrides: Partial<VectorRecord> = {}): VectorRecord {
  return {
    id: 'rec-1',
    organizationId: 'org-1',
    ownerType: 'knowledge_chunk',
    ownerId: 'chunk-1',
    embedding: embedding(),
    metadata: {},
    ...overrides,
  };
}

describe('assertEmbeddingDimensions', () => {
  it('accepts an embedding with exactly 1536 dimensions', () => {
    expect(() => assertEmbeddingDimensions(embedding())).not.toThrow();
  });

  it('rejects too-short embeddings', () => {
    expect(() => assertEmbeddingDimensions(embedding(1535), 'r')).toThrow(
      InvalidEmbeddingDimensionError,
    );
  });

  it('rejects too-long embeddings', () => {
    expect(() => assertEmbeddingDimensions(embedding(1537), 'r')).toThrow(
      InvalidEmbeddingDimensionError,
    );
  });

  it('rejects an empty embedding', () => {
    expect(() => assertEmbeddingDimensions([], 'r')).toThrow(
      InvalidEmbeddingDimensionError,
    );
  });

  it('carries the offending dimensionality on the error', () => {
    try {
      assertEmbeddingDimensions(embedding(10), 'rec-x');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEmbeddingDimensionError);
      const e = error as InvalidEmbeddingDimensionError;
      expect(e.actualDimensions).toBe(10);
      expect(e.expectedDimensions).toBe(1536);
      expect(e.recordId).toBe('rec-x');
    }
  });
});

describe('InMemoryVectorStore', () => {
  it('upserts records with 1536-dim embeddings', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([record()]);
    expect(store.size()).toBe(1);
  });

  it('rejects a batch containing any mismatched embedding and persists nothing', async () => {
    const store = new InMemoryVectorStore();
    await expect(
      store.upsert([
        record({ id: 'ok' }),
        record({ id: 'bad', embedding: embedding(100) }),
      ]),
    ).rejects.toBeInstanceOf(InvalidEmbeddingDimensionError);
    // All-or-nothing: the valid record must not have been stored either.
    expect(store.size()).toBe(0);
  });

  it('returns the most similar records first, scoped to the organization', async () => {
    const store = new InMemoryVectorStore();
    const near = embedding(EMBEDDING_DIMENSIONS, 0.5);
    const far = embedding(EMBEDDING_DIMENSIONS, -0.5);
    await store.upsert([
      record({ id: 'near', ownerId: 'a', embedding: near }),
      record({ id: 'far', ownerId: 'b', embedding: far }),
      record({ id: 'other-org', organizationId: 'org-2', embedding: near }),
    ]);

    const matches = await store.query(near, { organizationId: 'org-1' }, 10);
    expect(matches.map((m) => m.id)).toEqual(['near', 'far']);
    expect(matches[0]!.score).toBeGreaterThanOrEqual(matches[1]!.score);
  });

  it('honors owner type, owner id, and metadata filters', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      record({ id: 'a', ownerType: 'message', metadata: { lang: 'en' } }),
      record({ id: 'b', ownerType: 'document', metadata: { lang: 'en' } }),
      record({ id: 'c', ownerType: 'message', metadata: { lang: 'fr' } }),
    ]);

    const byType = await store.query(embedding(), {
      organizationId: 'org-1',
      ownerType: 'message',
    }, 10);
    expect(byType.map((m) => m.id).sort()).toEqual(['a', 'c']);

    const byMeta = await store.query(embedding(), {
      organizationId: 'org-1',
      metadata: { lang: 'en' },
    }, 10);
    expect(byMeta.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('limits results to k', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      record({ id: 'a' }),
      record({ id: 'b' }),
      record({ id: 'c' }),
    ]);
    const matches = await store.query(embedding(), { organizationId: 'org-1' }, 2);
    expect(matches).toHaveLength(2);
  });

  it('deletes records by id', async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([record({ id: 'a' }), record({ id: 'b' })]);
    await store.delete(['a', 'missing']);
    expect(store.size()).toBe(1);
  });
});

describe('PgVectorStore', () => {
  function fakeSql(rows: Record<string, unknown>[] = []): {
    client: SqlClient;
    calls: { text: string; params?: unknown[] }[];
  } {
    const calls: { text: string; params?: unknown[] }[] = [];
    const client: SqlClient = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        calls.push({ text, params });
        return { rows };
      }),
    };
    return { client, calls };
  }

  it('enforces the dimensionality invariant before issuing SQL', async () => {
    const { client, calls } = fakeSql();
    const store = new PgVectorStore(client);
    await expect(
      store.upsert([record({ embedding: embedding(512) })]),
    ).rejects.toBeInstanceOf(InvalidEmbeddingDimensionError);
    expect(calls).toHaveLength(0);
  });

  it('issues an upsert (INSERT ... ON CONFLICT) with a vector literal', async () => {
    const { client, calls } = fakeSql();
    const store = new PgVectorStore(client);
    await store.upsert([record({ id: 'rec-7', embedding: embedding(EMBEDDING_DIMENSIONS, 0.25) })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('ON CONFLICT (id) DO UPDATE');
    const params = calls[0]!.params!;
    expect(params[0]).toBe('rec-7');
    expect(String(params[4])).toMatch(/^\[0\.25,/);
  });

  it('builds a cosine-distance ordered query and maps rows to matches', async () => {
    const { client, calls } = fakeSql([
      { id: 'm1', owner_type: 'document', owner_id: 'd1', metadata: { a: 1 }, score: 0.9 },
    ]);
    const store = new PgVectorStore(client);
    const matches = await store.query(embedding(), {
      organizationId: 'org-1',
      ownerType: ['document', 'message'],
    }, 5);
    expect(calls[0]!.text).toContain('embedding <=> $1::vector');
    expect(matches).toEqual([
      { id: 'm1', ownerType: 'document', ownerId: 'd1', score: 0.9, metadata: { a: 1 } },
    ]);
  });

  it('parses string JSON metadata returned by the driver', async () => {
    const { client } = fakeSql([
      { id: 'm1', owner_type: 'message', owner_id: 'x', metadata: '{"k":"v"}', score: 0.5 },
    ]);
    const store = new PgVectorStore(client);
    const matches = await store.query(embedding(), { organizationId: 'org-1' }, 1);
    expect(matches[0]!.metadata).toEqual({ k: 'v' });
  });

  it('exposes idempotent migration SQL provisioning an HNSW index', () => {
    const sql = PgVectorStore.migrationSql();
    expect(sql).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(sql).toContain('vector(1536)');
    expect(sql).toContain('USING hnsw (embedding vector_cosine_ops)');
  });
});

describe('InMemoryObjectStore', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('round-trips object bytes', async () => {
    const store = new InMemoryObjectStore();
    await store.put('docs/a.txt', bytes('hello'));
    const out = await store.get('docs/a.txt');
    expect(new TextDecoder().decode(out)).toBe('hello');
  });

  it('reports existence and supports delete', async () => {
    const store = new InMemoryObjectStore();
    await store.put('k', bytes('v'));
    expect(await store.exists('k')).toBe(true);
    await store.delete('k');
    expect(await store.exists('k')).toBe(false);
  });

  it('throws ObjectNotFoundError for a missing key', async () => {
    const store = new InMemoryObjectStore();
    await expect(store.get('nope')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe('S3ObjectStore', () => {
  function fakeS3() {
    const objects = new Map<string, Uint8Array>();
    const client: S3ClientPort = {
      putObject: vi.fn(async ({ Key, Body }) => {
        objects.set(Key, Body);
      }),
      getObject: vi.fn(async ({ Key }) => {
        if (!objects.has(Key)) {
          const err = new Error('not found') as Error & { name: string };
          err.name = 'NoSuchKey';
          throw err;
        }
        const data = objects.get(Key)!;
        return { Body: { transformToByteArray: async () => data } };
      }),
      deleteObject: vi.fn(async ({ Key }) => {
        objects.delete(Key);
      }),
      headObject: vi.fn(async ({ Key }) => {
        if (!objects.has(Key)) {
          const err = new Error('not found') as Error & { name: string };
          err.name = 'NotFound';
          throw err;
        }
      }),
    };
    return { client, objects };
  }

  it('applies the key prefix and round-trips data', async () => {
    const { client, objects } = fakeS3();
    const store = new S3ObjectStore(client, { bucket: 'b', keyPrefix: 'tenant-a/' });
    await store.put('file.bin', new Uint8Array([1, 2, 3]));
    expect([...objects.keys()]).toEqual(['tenant-a/file.bin']);
    expect(Array.from(await store.get('file.bin'))).toEqual([1, 2, 3]);
  });

  it('maps a missing-object read to ObjectNotFoundError', async () => {
    const { client } = fakeS3();
    const store = new S3ObjectStore(client, { bucket: 'b' });
    await expect(store.get('missing')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it('returns false from exists() for a missing object', async () => {
    const { client } = fakeS3();
    const store = new S3ObjectStore(client, { bucket: 'b' });
    expect(await store.exists('missing')).toBe(false);
  });
});

describe('InMemoryCacheStore', () => {
  it('stores and retrieves values', async () => {
    const cache = new InMemoryCacheStore();
    await cache.set('k', { hello: 'world' });
    expect(await cache.get('k')).toEqual({ hello: 'world' });
    expect(await cache.has('k')).toBe(true);
  });

  it('returns null for missing keys', async () => {
    const cache = new InMemoryCacheStore();
    expect(await cache.get('absent')).toBeNull();
  });

  it('expires entries after the TTL elapses', async () => {
    let now = 1_000_000;
    const cache = new InMemoryCacheStore(() => now);
    await cache.set('k', 'v', 10);
    expect(await cache.get('k')).toBe('v');
    now += 11_000; // advance 11s past a 10s TTL
    expect(await cache.get('k')).toBeNull();
    expect(await cache.has('k')).toBe(false);
  });
});

describe('RedisCacheStore', () => {
  function fakeRedis() {
    const map = new Map<string, string>();
    const setSpy = vi.fn(
      async (key: string, value: string, _mode?: 'EX', _ttl?: number) => {
        map.set(key, value);
        return 'OK';
      },
    );
    const client: RedisClientPort = {
      get: async (key: string) => map.get(key) ?? null,
      set: setSpy,
      del: async (key: string) => (map.delete(key) ? 1 : 0),
      exists: async (key: string) => (map.has(key) ? 1 : 0),
    };
    return { client, map, setSpy };
  }

  it('JSON-serializes values and namespaces keys', async () => {
    const { client, map } = fakeRedis();
    const cache = new RedisCacheStore(client, { keyPrefix: 'cache:' });
    await cache.set('search:q1', { results: [1, 2] });
    expect(map.get('cache:search:q1')).toBe('{"results":[1,2]}');
    expect(await cache.get('search:q1')).toEqual({ results: [1, 2] });
  });

  it('passes EX + ttl when a positive TTL is given', async () => {
    const { client, setSpy } = fakeRedis();
    const cache = new RedisCacheStore(client);
    await cache.set('k', 'v', 30);
    expect(setSpy).toHaveBeenCalledWith('k', '"v"', 'EX', 30);
  });

  it('omits EX when no TTL is given', async () => {
    const { client, setSpy } = fakeRedis();
    const cache = new RedisCacheStore(client);
    await cache.set('k', 'v');
    expect(setSpy).toHaveBeenCalledWith('k', '"v"');
  });

  it('reports existence and delete', async () => {
    const { client } = fakeRedis();
    const cache = new RedisCacheStore(client);
    await cache.set('k', 1);
    expect(await cache.has('k')).toBe(true);
    await cache.delete('k');
    expect(await cache.has('k')).toBe(false);
  });
});
