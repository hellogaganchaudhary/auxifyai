/**
 * Replaceable storage layer for the Auxify Data Layer (Req 44).
 *
 * Exposes three stable, backend-agnostic interfaces — {@link VectorStore},
 * {@link ObjectStore}, {@link CacheStore} — together with local backend
 * implementations:
 *   - {@link PgVectorStore}    pgvector + HNSW, 1536-dim embeddings (Req 44.2/44.3)
 *   - {@link S3ObjectStore}    S3 / MinIO (Req 44.5)
 *   - {@link RedisCacheStore}  Redis (Req 44.4)
 *
 * In-memory backends ({@link InMemoryVectorStore}, {@link InMemoryObjectStore},
 * {@link InMemoryCacheStore}) provide spec-faithful fakes for tests and prove
 * that consumers are decoupled from any single backend.
 */

// Shared types and the dimensionality invariant.
export {
  EMBEDDING_DIMENSIONS,
  InvalidEmbeddingDimensionError,
  assertEmbeddingDimensions,
  assertRecordsValid,
  type VectorOwnerType,
  type VectorRecord,
  type VectorFilter,
  type VectorMatch,
} from './types.js';

// Stable interfaces.
export {
  ObjectNotFoundError,
  type VectorStore,
  type ObjectStore,
  type CacheStore,
  type PutObjectOptions,
} from './interfaces.js';

// In-memory backends (reference implementations / test fakes).
export {
  InMemoryVectorStore,
  InMemoryObjectStore,
  InMemoryCacheStore,
} from './memory.js';

// pgvector backend.
export {
  PgVectorStore,
  type SqlClient,
  type SqlRow,
  type SqlQueryResult,
  type PgVectorStoreOptions,
} from './pgvector.js';

// S3 / MinIO backend.
export {
  S3ObjectStore,
  type S3ClientPort,
  type S3PutObjectInput,
  type S3ObjectRef,
  type S3GetObjectResult,
  type S3ObjectStoreOptions,
} from './s3.js';

// Redis backend.
export {
  RedisCacheStore,
  type RedisClientPort,
  type RedisCacheStoreOptions,
} from './redis.js';
