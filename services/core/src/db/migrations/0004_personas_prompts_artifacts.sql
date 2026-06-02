-- Migration 0004: Personas, prompts, and artifacts
--
-- Personas and prompt templates are user-owned (Req 9.x, 10.x). Prompt
-- templates and artifacts are versioned: every edit appends an immutable
-- version row while the head row advances its version number (Property 25,
-- Req 10.5, 12.4).
--
-- Requirements: 9.x, 10.x, 12.x, 44.8.

CREATE TABLE IF NOT EXISTS personas (
  id            TEXT PRIMARY KEY,
  -- System/default personas have no owner; user personas reference their owner.
  owner_id      TEXT REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  category      TEXT        NOT NULL DEFAULT '',
  system_prompt TEXT        NOT NULL DEFAULT '',
  is_default    BOOLEAN     NOT NULL DEFAULT false,
  variables     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personas_owner_id_idx ON personas (owner_id);

CREATE TABLE IF NOT EXISTS prompt_templates (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  content         TEXT        NOT NULL DEFAULT '',
  category        TEXT        NOT NULL DEFAULT '',
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  visibility      TEXT        NOT NULL DEFAULT 'personal'
                    CHECK (visibility IN ('public', 'personal')),
  version         INTEGER     NOT NULL DEFAULT 1,
  usage_count     INTEGER     NOT NULL DEFAULT 0,
  rating_avg      NUMERIC(6, 3) NOT NULL DEFAULT 0,
  share_count     INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prompt_templates_owner_id_idx ON prompt_templates (owner_id);
CREATE INDEX IF NOT EXISTS prompt_templates_organization_id_idx
  ON prompt_templates (organization_id);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES prompt_templates (id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL,
  content     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_template_version_unique UNIQUE (template_id, version)
);
CREATE INDEX IF NOT EXISTS prompt_versions_template_id_idx ON prompt_versions (template_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  type            TEXT NOT NULL
                    CHECK (type IN ('code', 'markdown', 'mermaid', 'react', 'svg', 'csv', 'html')),
  content         TEXT        NOT NULL DEFAULT '',
  version         INTEGER     NOT NULL DEFAULT 1,
  shared_with     TEXT[]      NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_conversation_id_idx ON artifacts (conversation_id);

CREATE TABLE IF NOT EXISTS artifact_versions (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
  version     INTEGER     NOT NULL,
  content     TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifact_versions_artifact_version_unique UNIQUE (artifact_id, version)
);
CREATE INDEX IF NOT EXISTS artifact_versions_artifact_id_idx ON artifact_versions (artifact_id);
