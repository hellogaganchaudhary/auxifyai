/**
 * Server-side persistence wiring for the API.
 *
 * Opens a PostgreSQL connection pool (when `DATABASE_URL` is configured),
 * ensures the minimal `conversations` + `messages` schema the
 * {@link ConversationRepository}/{@link MessageRepository} expect, and exposes
 * the pool as the narrow `SqlClient` port those repositories consume.
 *
 * This is intentionally self-contained: it provisions exactly the two tables
 * (and their tenant column / parent FK) the chat product persists to, with
 * `CREATE TABLE IF NOT EXISTS` so it is idempotent and safe to run on every
 * boot. When `DATABASE_URL` is absent the API runs exactly as before with no
 * persistence (the web client keeps its local history), so this is additive.
 */

import pg from 'pg';
import type { SqlClient } from '@auxify/core';

const { Pool } = pg;

/** A live database handle: the SqlClient port plus a close hook. */
export interface Database {
  /** The narrow query port the repositories consume. */
  sql: SqlClient;
  /** Whether the pgvector store (`vector_records`) is provisioned and usable. */
  vectorReady: boolean;
  /** Close the underlying pool on shutdown. */
  close: () => Promise<void>;
}

/** The schema the chat product persists to (conversations + messages). */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id      TEXT NOT NULL DEFAULT 'default',
  owner_id        TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  folder_id       TEXT,
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  share_token     TEXT,
  share_mode      TEXT CHECK (share_mode IN ('read', 'collab')),
  persona_id      TEXT,
  active_model_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_org_owner_idx
  ON conversations (organization_id, owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  parent_id       TEXT,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         JSONB NOT NULL DEFAULT '[]'::jsonb,
  model           TEXT,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost            NUMERIC,
  latency_ms      INTEGER,
  rating          TEXT CHECK (rating IN ('up', 'neutral', 'down')),
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, created_at ASC);
`;

/**
 * The knowledge / collaboration tables that do NOT require pgvector (RAG
 * sources, documents, hub pages, messaging channels + messages). Provisioned
 * with `CREATE ... IF NOT EXISTS` so it is idempotent and additive, and runs
 * even on a plain Postgres without the vector extension.
 */
const KNOWLEDGE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'text',
  status          TEXT NOT NULL DEFAULT 'ready',
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_org_idx
  ON knowledge_sources (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS documents (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  content         TEXT NOT NULL DEFAULT '',
  mime_type       TEXT NOT NULL DEFAULT 'text/plain',
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_org_idx
  ON documents (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_pages (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_pages_org_idx
  ON knowledge_pages (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS channels (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  topic           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channels_org_idx
  ON channels (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS channel_messages (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  author_id       TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channel_messages_idx
  ON channel_messages (channel_id, created_at ASC);
`;

/**
 * The pgvector store + index. Requires the `vector` extension; provisioned
 * separately so its absence never blocks the non-vector knowledge tables.
 */
const VECTOR_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS vector_records (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_type      TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  embedding       vector(1536) NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS vector_records_embedding_hnsw
  ON vector_records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS vector_records_org_idx
  ON vector_records (organization_id);
CREATE INDEX IF NOT EXISTS vector_records_owner_idx
  ON vector_records (organization_id, owner_type, owner_id);
`;

/**
 * Connect to PostgreSQL and ensure the schema, returning a {@link Database} —
 * or `null` when `DATABASE_URL` is not set (persistence stays disabled and the
 * API runs unchanged).
 */
export async function initDatabase(): Promise<Database | null> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    return null;
  }

  const pool = new Pool({ connectionString, max: 10 });
  let vectorReady = false;
  try {
    await pool.query('SELECT 1');
    await pool.query(SCHEMA_SQL);
    // Non-vector knowledge/collab tables — always provisioned so messaging,
    // documents, hub pages, analytics, and admin work on a plain Postgres.
    await pool.query(KNOWLEDGE_TABLES_SQL);
    // The vector store needs the pgvector extension; provision it separately so
    // its absence degrades RAG gracefully without breaking the other features.
    try {
      await pool.query(VECTOR_SCHEMA_SQL);
      vectorReady = true;
    } catch (vectorError) {
      process.stderr.write(
        `[database] vector store skipped (pgvector unavailable): ${
          vectorError instanceof Error ? vectorError.message : String(vectorError)
        }\n`,
      );
    }
  } catch (error) {
    await pool.end();
    if (process.env.REQUIRE_DATABASE === 'true' || process.env.NODE_ENV === 'production') {
      throw error;
    }
    process.stderr.write(
      `[database] unavailable; persistence disabled for this local run: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return null;
  }

  return {
    sql: { query: (text, params) => pool.query(text, params) },
    vectorReady,
    close: () => pool.end(),
  };
}
