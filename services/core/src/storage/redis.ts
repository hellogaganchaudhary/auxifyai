/**
 * Redis-backed {@link CacheStore}.
 *
 * Talks to Redis through a narrow {@link RedisClientPort} rather than a
 * concrete driver, so it works with `ioredis`, `node-redis`, or a fake in
 * tests, and keeps the platform's dependency on Redis at this one boundary
 * (Req 44.4). Values are JSON-serialized; TTLs use Redis' second-granularity
 * expiry (`SET key value EX ttl`).
 */

import type { CacheStore } from './interfaces.js';

/**
 * Narrow port over the Redis commands the cache needs. Method signatures match
 * common clients (`ioredis`): `set(key, value, 'EX', seconds)`.
 */
export interface RedisClientPort {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: 'EX',
    ttlSeconds?: number,
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
  exists(key: string): Promise<number>;
}

/** Configuration for {@link RedisCacheStore}. */
export interface RedisCacheStoreOptions {
  /** Optional key namespace prefix (e.g. `cache:`) applied to every key. */
  keyPrefix?: string;
}

/** Production {@link CacheStore} backed by Redis. */
export class RedisCacheStore implements CacheStore {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: RedisClientPort,
    options: RedisCacheStoreOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? '';
  }

  private namespaced(key: string): string {
    return this.keyPrefix ? `${this.keyPrefix}${key}` : key;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.namespaced(key));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    const namespacedKey = this.namespaced(key);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.set(namespacedKey, serialized, 'EX', Math.floor(ttlSeconds));
    } else {
      await this.client.set(namespacedKey, serialized);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.namespaced(key));
  }

  async has(key: string): Promise<boolean> {
    const count = await this.client.exists(this.namespaced(key));
    return count > 0;
  }
}
