-- Migration 0001: Extensions
--
-- Provisions the PostgreSQL extensions the Primary_Database depends on.
-- Idempotent: safe to run repeatedly (CREATE EXTENSION IF NOT EXISTS).
--
-- These mirror infra/local/postgres/init/01-extensions.sql so the schema can be
-- bootstrapped from migrations alone (e.g. in CI or a fresh cloud database)
-- without relying on the docker-entrypoint-initdb.d hook.
--
-- Requirements: 44.1 (system of record), 44.2 (pgvector + HNSW).

-- pgvector: 1536-dimension embedding storage + HNSW indexing (Req 44.2, 44.3).
CREATE EXTENSION IF NOT EXISTS vector;

-- pg_trgm: trigram indexes for keyword / hybrid search alongside vector search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- pgcrypto: gen_random_uuid() for server-side identifier defaults where useful.
-- (PostgreSQL 13+ ships gen_random_uuid() in core, but enabling pgcrypto keeps
-- the migration portable to environments that expect it from the extension.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
