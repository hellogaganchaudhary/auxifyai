-- Migration 0005: Files, knowledge base, RAG
--
-- Files are org-scoped uploads. The knowledge base is a hierarchy:
--   Collection → Source → Document → Chunk
-- Each chunk carries its source attribution (Req 24.4). Deleting a collection
-- cascades through sources, documents, and chunks (Req 44.8 / Property 58).
--
-- Embeddings themselves live in the Vector_Store (vector_records, migration
-- 0012) behind the migratable VectorStore interface (Req 44.2, 44.3); knowledge
-- chunks reference those records by id at the application layer.
--
-- Requirements: 11.x, 23.x, 24.x, 25.x, 44.8.

CREATE TABLE IF NOT EXISTS files (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  content_type    TEXT        NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      BIGINT      NOT NULL DEFAULT 0,
  object_key      TEXT        NOT NULL,
  malware_scan    TEXT        NOT NULL DEFAULT 'clean'
                    CHECK (malware_scan IN ('clean', 'threat')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_organization_id_idx ON files (organization_id);
CREATE INDEX IF NOT EXISTS files_owner_id_idx ON files (owner_id);

CREATE TABLE IF NOT EXISTS knowledge_collections (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_scope       TEXT NOT NULL CHECK (owner_scope IN ('team', 'project')),
  owner_scope_id    TEXT NOT NULL,
  name              TEXT NOT NULL,
  allowed_teams     TEXT[]      NOT NULL DEFAULT '{}',
  allowed_projects  TEXT[]      NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_collections_organization_id_idx
  ON knowledge_collections (organization_id);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id             TEXT PRIMARY KEY,
  collection_id  TEXT NOT NULL REFERENCES knowledge_collections (id) ON DELETE CASCADE,
  type           TEXT NOT NULL,
  sync_mode      TEXT NOT NULL DEFAULT 'manual'
                   CHECK (sync_mode IN ('realtime', 'scheduled', 'manual')),
  sync_status    TEXT        NOT NULL DEFAULT 'idle',
  last_sync_at   TIMESTAMPTZ,
  document_count INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_collection_id_idx
  ON knowledge_sources (collection_id);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES knowledge_sources (id) ON DELETE CASCADE,
  title         TEXT        NOT NULL DEFAULT '',
  content_hash  TEXT        NOT NULL DEFAULT '',
  stale         BOOLEAN     NOT NULL DEFAULT false,
  -- Self-reference for de-duplication (Req 23.4); detaching the original simply
  -- clears the pointer rather than deleting the duplicate row.
  duplicate_of  TEXT REFERENCES knowledge_documents (id) ON DELETE SET NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_documents_source_id_idx
  ON knowledge_documents (source_id);
CREATE INDEX IF NOT EXISTS knowledge_documents_content_hash_idx
  ON knowledge_documents (content_hash);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents (id) ON DELETE CASCADE,
  ordinal     INTEGER     NOT NULL DEFAULT 0,
  text        TEXT        NOT NULL DEFAULT '',
  attribution JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_chunks_document_ordinal_unique UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_id_idx
  ON knowledge_chunks (document_id);
