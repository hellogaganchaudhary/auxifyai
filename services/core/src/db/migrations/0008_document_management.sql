-- Migration 0008: Document Management (DMS)
--
-- Documents are Project-scoped, live inside an optional folder tree, are
-- versioned (document_versions, Property 25 / Req 28.1, 28.3), and carry
-- retention/soft-delete metadata (Req 28.6).
--
-- Requirements: 28.x, 44.8.

CREATE TABLE IF NOT EXISTS folders (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Folder tree: deleting a parent folder removes the descending subtree.
  parent_id       TEXT REFERENCES folders (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS folders_organization_id_idx ON folders (organization_id);
CREATE INDEX IF NOT EXISTS folders_project_id_idx ON folders (project_id);
CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders (parent_id);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Moving a document to the unfiled root is allowed, so clear the folder ref
  -- rather than delete the document when its folder is removed.
  folder_id       TEXT REFERENCES folders (id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  content_type    TEXT        NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      BIGINT      NOT NULL DEFAULT 0,
  version         INTEGER     NOT NULL DEFAULT 1,
  object_key      TEXT        NOT NULL,
  permissions     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  retention_until TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_organization_id_idx ON documents (organization_id);
CREATE INDEX IF NOT EXISTS documents_project_id_idx ON documents (project_id);
CREATE INDEX IF NOT EXISTS documents_folder_id_idx ON documents (folder_id);

CREATE TABLE IF NOT EXISTS document_versions (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL,
  object_key  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_versions_document_version_unique UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS document_versions_document_id_idx
  ON document_versions (document_id);
