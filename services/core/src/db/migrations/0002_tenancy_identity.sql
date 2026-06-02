-- Migration 0002: Core tenancy and identity
--
-- Organizations → Teams → Projects form the three-level tenancy hierarchy
-- (Req 1.x). Users belong to an Organization; Memberships place a user within a
-- Team/Project; Policies hold the allow-lists evaluated by the Policy_Engine.
--
-- FK policy (see services/core/src/db/README.md):
--   * Tenancy containment edges use ON DELETE CASCADE (Req 44.8 / Property 58).
--   * organization_id is the tenant column carried by every tenant-scoped table.
--
-- Requirements: 44.1, 44.8.

CREATE TABLE IF NOT EXISTS organizations (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  data_residency_region       TEXT,
  storage_quota_bytes         BIGINT      NOT NULL DEFAULT 0,
  conversation_retention_days INTEGER     NOT NULL DEFAULT 365,
  file_retention_days         INTEGER     NOT NULL DEFAULT 180,
  mfa_policy                  TEXT        NOT NULL DEFAULT 'optional'
                                CHECK (mfa_policy IN ('optional', 'required')),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  budget          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS teams_organization_id_idx ON teams (organization_id);

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  team_id         TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  access_list     TEXT[]      NOT NULL DEFAULT '{}',
  budget          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_organization_id_idx ON projects (organization_id);
CREATE INDEX IF NOT EXISTS projects_team_id_idx ON projects (team_id);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  roles             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  allowed_models    TEXT[]      NOT NULL DEFAULT '{}',
  premium_authorized BOOLEAN    NOT NULL DEFAULT false,
  status            TEXT        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'deactivated')),
  mfa_enabled       BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Email is unique within an Organization (not globally).
  CONSTRAINT users_org_email_unique UNIQUE (organization_id, email)
);
CREATE INDEX IF NOT EXISTS users_organization_id_idx ON users (organization_id);

CREATE TABLE IF NOT EXISTS memberships (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  team_id         TEXT REFERENCES teams (id) ON DELETE CASCADE,
  project_id      TEXT REFERENCES projects (id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memberships_user_id_idx ON memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_organization_id_idx ON memberships (organization_id);
CREATE INDEX IF NOT EXISTS memberships_team_id_idx ON memberships (team_id);
CREATE INDEX IF NOT EXISTS memberships_project_id_idx ON memberships (project_id);

CREATE TABLE IF NOT EXISTS policies (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  scope           TEXT NOT NULL CHECK (scope IN ('org', 'team', 'user')),
  scope_id        TEXT NOT NULL,
  allow_list      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policies_organization_id_idx ON policies (organization_id);
CREATE INDEX IF NOT EXISTS policies_scope_idx ON policies (scope, scope_id);
