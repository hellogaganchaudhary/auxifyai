-- Migration 0010: API keys and audit logs
--
-- API keys are org-scoped and owned by a user; only a prefix + hash are stored,
-- never the secret (Req 21.x, 35.4). Audit logs are immutable (Req 37.3) and
-- retained 7 years (Req 37.4); immutability is enforced by the application /
-- DB privileges and a guard trigger below.
--
-- Requirements: 21.x, 37.x, 44.1, 44.8.

CREATE TABLE IF NOT EXISTS api_keys (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  prefix          TEXT NOT NULL,
  hash            TEXT NOT NULL,
  active          BOOLEAN     NOT NULL DEFAULT true,
  expires_at      TIMESTAMPTZ,
  rate_limit      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_prefix_unique UNIQUE (prefix)
);
CREATE INDEX IF NOT EXISTS api_keys_organization_id_idx ON api_keys (organization_id);
CREATE INDEX IF NOT EXISTS api_keys_owner_id_idx ON api_keys (owner_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  actor_id        TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  resource_type   TEXT        NOT NULL,
  resource_id     TEXT        NOT NULL,
  ip              TEXT        NOT NULL DEFAULT '',
  user_agent      TEXT        NOT NULL DEFAULT '',
  "timestamp"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_organization_id_idx ON audit_logs (organization_id);
CREATE INDEX IF NOT EXISTS audit_logs_actor_id_idx ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id);
-- Audit query soundness/completeness over actor/action/resource/org/time
-- (Req 37.5 / Property 8) is served by these indexes plus the time index.
CREATE INDEX IF NOT EXISTS audit_logs_timestamp_idx ON audit_logs ("timestamp");

-- Immutability guard (Req 37.3 / Property 7): reject UPDATE and DELETE on
-- audit_logs at the database layer. Inserts remain allowed.
CREATE OR REPLACE FUNCTION audit_logs_block_mutation()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();

DROP TRIGGER IF EXISTS audit_logs_no_delete ON audit_logs;
CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
