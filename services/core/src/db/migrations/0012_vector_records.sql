-- Migration 0012: Vector store records (pgvector + HNSW)
--
-- The Vector_Store holds 1536-dimension embeddings indexed with HNSW (cosine),
-- behind the migratable VectorStore interface (Req 44.2, 44.3). This DDL is kept
-- byte-for-byte consistent with PgVectorStore.migrationSql() in
-- services/core/src/storage/pgvector.ts — the migration-SQL unit tests assert
-- the two stay in sync so the schema has a single source of truth.
--
-- Requirements: 44.2, 44.3.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS vector_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS vector_records_embedding_hnsw
  ON vector_records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS vector_records_org_idx ON vector_records (organization_id);
