-- Migration 0006: Knowledge Hub (enterprise wiki)
--
-- Knowledge pages are Project-scoped and form a tree (parent_id). Pages are
-- versioned (page_versions, Property 25 / Req 26.3, 26.4) and support anchored
-- comments (Req 26.5).
--
-- Requirements: 26.x, 44.8.

CREATE TABLE IF NOT EXISTS knowledge_pages (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Page tree: a child page references its parent; deleting a parent removes
  -- the descending subtree (Req 26.1, 44.8).
  parent_id       TEXT REFERENCES knowledge_pages (id) ON DELETE CASCADE,
  title           TEXT        NOT NULL DEFAULT '',
  content         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  author_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version         INTEGER     NOT NULL DEFAULT 1,
  permissions     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_pages_organization_id_idx
  ON knowledge_pages (organization_id);
CREATE INDEX IF NOT EXISTS knowledge_pages_project_id_idx ON knowledge_pages (project_id);
CREATE INDEX IF NOT EXISTS knowledge_pages_parent_id_idx ON knowledge_pages (parent_id);

CREATE TABLE IF NOT EXISTS page_versions (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL REFERENCES knowledge_pages (id) ON DELETE CASCADE,
  version    INTEGER     NOT NULL,
  content    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT page_versions_page_version_unique UNIQUE (page_id, version)
);
CREATE INDEX IF NOT EXISTS page_versions_page_id_idx ON page_versions (page_id);

CREATE TABLE IF NOT EXISTS page_comments (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL REFERENCES knowledge_pages (id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  anchor     TEXT        NOT NULL DEFAULT '',
  body       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS page_comments_page_id_idx ON page_comments (page_id);
