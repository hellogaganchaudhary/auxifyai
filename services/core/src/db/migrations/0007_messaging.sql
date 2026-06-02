-- Migration 0007: Team Communication (channels, DMs, threads, notifications)
--
-- Channels are team/project-scoped. Channel messages thread via parent_id and
-- belong either to a channel or a DM thread (Req 27.2-27.5). Notifications are
-- user-scoped.
--
-- Requirements: 27.x, 44.8.

CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner_scope     TEXT NOT NULL CHECK (owner_scope IN ('team', 'project')),
  owner_scope_id  TEXT NOT NULL,
  name            TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public', 'private')),
  members         TEXT[]      NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channels_organization_id_idx ON channels (organization_id);

CREATE TABLE IF NOT EXISTS channel_messages (
  id           TEXT PRIMARY KEY,
  -- A message belongs to a channel or a DM thread; both edges cascade.
  channel_id   TEXT REFERENCES channels (id) ON DELETE CASCADE,
  dm_thread_id TEXT,
  -- Threaded replies reference their parent message (Req 27.5, 44.8).
  parent_id    TEXT REFERENCES channel_messages (id) ON DELETE CASCADE,
  author_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body         TEXT        NOT NULL DEFAULT '',
  file_ref     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_messages_channel_id_idx ON channel_messages (channel_id);
CREATE INDEX IF NOT EXISTS channel_messages_dm_thread_id_idx ON channel_messages (dm_thread_id);
CREATE INDEX IF NOT EXISTS channel_messages_parent_id_idx ON channel_messages (parent_id);
CREATE INDEX IF NOT EXISTS channel_messages_channel_created_idx
  ON channel_messages (channel_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       TEXT        NOT NULL DEFAULT '',
  source_ref TEXT        NOT NULL DEFAULT '',
  read       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON notifications (user_id);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id, read) WHERE read = false;
