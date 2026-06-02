-- =============================================================================
-- Auxify AI — database bootstrap (run once on first deploy)
-- Enables pgvector (the RAG "complete memory" vector store) and supporting
-- extensions on the primary RDS PostgreSQL 16 database.
--
-- RDS is intentionally in PRIVATE subnets with no public access, so this runs
-- from inside the VPC — either the API's Prisma migration step on boot, or a
-- one-off ECS task on the auxify-prod-cluster. It is idempotent.
-- =============================================================================

-- Vector similarity search for embeddings (knowledge chunks, messages, docs).
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram + fuzzy text for hybrid (semantic + keyword) retrieval.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- UUID generation for primary keys.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Query performance visibility (matches shared_preload_libraries).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Sanity check: confirm pgvector is available and report its version.
DO $$
DECLARE
  v text;
BEGIN
  SELECT extversion INTO v FROM pg_extension WHERE extname = 'vector';
  RAISE NOTICE 'pgvector enabled, version=%', v;
END $$;
