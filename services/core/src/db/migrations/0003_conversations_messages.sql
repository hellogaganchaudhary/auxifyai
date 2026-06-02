-- Migration 0003: Conversations and messages
--
-- Conversations are Project-scoped. Messages form a branch tree via a
-- self-referential parent_id (Req 6.1, 6.2) and capture the full request
-- outcome required for the message-persistence round-trip (Req 44.6): the
-- conversation reference, parent reference, role, content, model, input/output
-- token counts, cost, and latency.
--
-- Requirements: 5.1, 5.2, 6.x, 44.6, 44.8.

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title           TEXT        NOT NULL DEFAULT '',
  folder_id       TEXT,
  archived        BOOLEAN     NOT NULL DEFAULT false,
  share_token     TEXT,
  share_mode      TEXT CHECK (share_mode IN ('read', 'collab')),
  persona_id      TEXT,
  active_model_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_organization_id_idx ON conversations (organization_id);
CREATE INDEX IF NOT EXISTS conversations_project_id_idx ON conversations (project_id);
CREATE INDEX IF NOT EXISTS conversations_owner_id_idx ON conversations (owner_id);
-- Conversation list ordering is by most-recent update (Req 5.2 / Property 17).
CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx
  ON conversations (owner_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_share_token_idx
  ON conversations (share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- Branch tree: a reply/edit/branch references its parent message. Deleting a
  -- parent message removes the descending branch (Req 6.1, 6.2, 44.6, 44.8).
  parent_id       TEXT REFERENCES messages (id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost            NUMERIC(18, 8),
  latency_ms      INTEGER,
  rating          TEXT CHECK (rating IN ('up', 'neutral', 'down')),
  pinned          BOOLEAN     NOT NULL DEFAULT false,
  attachments     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS messages_parent_id_idx ON messages (parent_id);
-- Thread traversal: messages of a conversation in chronological order.
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at);
