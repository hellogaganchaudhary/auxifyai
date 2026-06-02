-- Migration 0013: User invitations
--
-- An administrator invites a user by email; the invitation is persisted with a
-- single-use token and the roles to grant. On acceptance the platform creates
-- the user account and marks the invitation accepted (Req 20.3). Invitations
-- are Organization-scoped like every other tenant resource (Req 1.2).
--
-- Status lifecycle:
--   pending  → the default on creation; the invitation can still be accepted.
--   accepted → the invitee accepted and a user account was created.
--   revoked  → an administrator cancelled the invitation before acceptance.
--
-- Requirements: 1.2, 20.3, 44.1, 44.8.

CREATE TABLE IF NOT EXISTS invitations (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  roles           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  token           TEXT NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'revoked')),
  invited_by      TEXT REFERENCES users (id) ON DELETE SET NULL,
  accepted_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  expires_at      TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invitations_token_unique UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS invitations_organization_id_idx ON invitations (organization_id);
CREATE INDEX IF NOT EXISTS invitations_email_idx ON invitations (organization_id, email);
CREATE INDEX IF NOT EXISTS invitations_status_idx ON invitations (status);
