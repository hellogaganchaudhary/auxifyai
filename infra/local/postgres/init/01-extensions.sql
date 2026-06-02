-- Enable the pgvector extension required for 1536-dim embedding storage and
-- HNSW indexing (Requirements 44.2, 44.3). Runs automatically on first
-- container start via the Postgres docker-entrypoint-initdb.d hook.
CREATE EXTENSION IF NOT EXISTS vector;

-- pg_trgm supports hybrid (keyword) search alongside vector similarity.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
