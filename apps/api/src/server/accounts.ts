/**
 * User accounts, sessions, and server-side chat persistence.
 *
 * Backs the multi-user product:
 *   - A super-admin (seeded from APP_AUTH_EMAIL/APP_AUTH_PASSWORD) who can
 *     create additional users (email = username, password set by the admin).
 *   - Email/password login that issues a signed session token (HMAC) carrying
 *     the user id, email, and role.
 *   - Every conversation (with all messages, responses, and media) stored in
 *     PostgreSQL per user, so nothing vanishes and history shows in the account.
 *   - Super-admin monitoring: list all users and read any user's conversations.
 *
 * All state lives in three idempotently-provisioned tables; passwords are
 * scrypt-hashed with a per-user salt and never stored or logged in plaintext.
 */

import { createHmac, randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { SqlClient } from '@auxify/core';

/** A user record (never includes the password hash). */
export interface AccountUser {
  id: string;
  email: string;
  role: 'superadmin' | 'user';
  active: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** A decoded, verified session. */
export interface Session {
  userId: string;
  email: string;
  role: 'superadmin' | 'user';
}

/** A conversation list entry (no payload). */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** Schema for users + conversations (idempotent). */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT
);
CREATE TABLE IF NOT EXISTS app_conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New chat',
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS app_conversations_user_idx ON app_conversations (user_id, updated_at DESC);
`;

/** Hash a password with scrypt + a fresh random salt → `scrypt$salt$hash`. */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/** Constant-time verify a password against a stored `scrypt$salt$hash`. */
function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1] ?? '';
  const expected = Buffer.from(parts[2] ?? '', 'hex');
  const derived = scryptSync(password, salt, expected.length || 64);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/** Build the accounts/persistence service bound to a SQL client + token secret. */
export function buildAccountsService(sql: SqlClient, secret: string) {
  /** Provision the schema (idempotent). */
  async function ensureSchema(): Promise<void> {
    await sql.query(SCHEMA_SQL);
  }

  /** Seed the super-admin from env if it does not already exist. */
  async function bootstrapSuperadmin(email: string, password: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    if (normalized.length === 0 || password.length === 0) return;
    const existing = await sql.query('SELECT id, role FROM app_users WHERE email = $1', [normalized]);
    if (existing.rows.length === 0) {
      await sql.query(
        `INSERT INTO app_users (id, email, password_hash, role, created_by)
         VALUES ($1, $2, $3, 'superadmin', 'system')`,
        [`usr_${randomUUID()}`, normalized, hashPassword(password)],
      );
    }
  }

  /** Mint a signed session token. */
  function mintToken(user: { id: string; email: string; role: string }): string {
    const body = Buffer.from(
      JSON.stringify({ uid: user.id, email: user.email, role: user.role, iat: Date.now() }),
      'utf8',
    ).toString('base64url');
    const sig = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  /** Verify a session token and return the {@link Session}, or null. */
  function verifyToken(token: string | undefined): Session | null {
    if (token === undefined || token.length === 0) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    try {
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
        uid?: string;
        email?: string;
        role?: string;
      };
      if (typeof decoded.uid !== 'string' || typeof decoded.email !== 'string') return null;
      const role = decoded.role === 'superadmin' ? 'superadmin' : 'user';
      return { userId: decoded.uid, email: decoded.email, role };
    } catch {
      return null;
    }
  }

  /** Validate credentials and return a session token + user, or null. */
  async function login(email: string, password: string): Promise<{ token: string; user: AccountUser } | null> {
    const normalized = email.trim().toLowerCase();
    const result = await sql.query(
      'SELECT id, email, password_hash, role, active, created_at, created_by FROM app_users WHERE email = $1',
      [normalized],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.active === false) return null;
    if (!verifyPassword(password, String(row.password_hash))) return null;
    const user = rowToUser(row);
    return { token: mintToken({ id: user.id, email: user.email, role: user.role }), user };
  }

  /** Create a new user (super-admin only — caller enforces). */
  async function createUser(
    email: string,
    password: string,
    role: 'superadmin' | 'user',
    createdBy: string,
  ): Promise<AccountUser> {
    const normalized = email.trim().toLowerCase();
    if (normalized.length === 0 || password.length < 6) {
      throw new Error('a valid email and a password of at least 6 characters are required');
    }
    const dup = await sql.query('SELECT 1 FROM app_users WHERE email = $1', [normalized]);
    if (dup.rows.length > 0) throw new Error('a user with that email already exists');
    const id = `usr_${randomUUID()}`;
    const result = await sql.query(
      `INSERT INTO app_users (id, email, password_hash, role, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, role, active, created_at, created_by`,
      [id, normalized, hashPassword(password), role, createdBy],
    );
    return rowToUser(result.rows[0] ?? {});
  }

  /** List all users (super-admin only). */
  async function listUsers(): Promise<AccountUser[]> {
    const result = await sql.query(
      'SELECT id, email, role, active, created_at, created_by FROM app_users ORDER BY created_at ASC',
    );
    return result.rows.map(rowToUser);
  }

  /** Set a user's active flag (super-admin only). */
  async function setUserActive(userId: string, active: boolean): Promise<void> {
    await sql.query('UPDATE app_users SET active = $2 WHERE id = $1', [userId, active]);
  }

  /** List a user's conversations (most-recent first). */
  async function listConversations(userId: string): Promise<ConversationSummary[]> {
    const result = await sql.query(
      'SELECT id, title, updated_at FROM app_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 500',
      [userId],
    );
    return result.rows.map((r) => ({
      id: String(r.id),
      title: typeof r.title === 'string' ? r.title : 'New chat',
      updatedAt: new Date(String(r.updated_at)).toISOString(),
    }));
  }

  /** Fetch one conversation's full payload (optionally for any user when admin). */
  async function getConversation(
    requesterId: string,
    isAdmin: boolean,
    conversationId: string,
  ): Promise<Record<string, unknown> | null> {
    const result = isAdmin
      ? await sql.query('SELECT payload FROM app_conversations WHERE id = $1', [conversationId])
      : await sql.query('SELECT payload FROM app_conversations WHERE id = $1 AND user_id = $2', [
          conversationId,
          requesterId,
        ]);
    const row = result.rows[0];
    if (row === undefined) return null;
    return (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>;
  }

  /** Upsert a conversation (full payload incl. messages + media) for a user. */
  async function saveConversation(
    userId: string,
    conversation: { id: string; title?: string; [k: string]: unknown },
  ): Promise<void> {
    const id = conversation.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error('conversation id is required');
    const title = typeof conversation.title === 'string' ? conversation.title : 'New chat';
    await sql.query(
      `INSERT INTO app_conversations (id, user_id, title, payload, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         payload = EXCLUDED.payload,
         updated_at = now()
       WHERE app_conversations.user_id = EXCLUDED.user_id`,
      [id, userId, title, JSON.stringify(conversation)],
    );
  }

  /** Delete a conversation owned by the user. */
  async function deleteConversation(userId: string, conversationId: string): Promise<void> {
    await sql.query('DELETE FROM app_conversations WHERE id = $1 AND user_id = $2', [conversationId, userId]);
  }

  /** Super-admin: every conversation across all users, with owner email. */
  async function adminListConversations(): Promise<Array<ConversationSummary & { email: string; userId: string }>> {
    const result = await sql.query(
      `SELECT c.id, c.title, c.updated_at, c.user_id, u.email
       FROM app_conversations c JOIN app_users u ON u.id = c.user_id
       ORDER BY c.updated_at DESC LIMIT 1000`,
    );
    return result.rows.map((r) => ({
      id: String(r.id),
      title: typeof r.title === 'string' ? r.title : 'New chat',
      updatedAt: new Date(String(r.updated_at)).toISOString(),
      userId: String(r.user_id),
      email: String(r.email),
    }));
  }

  return {
    ensureSchema,
    bootstrapSuperadmin,
    verifyToken,
    login,
    createUser,
    listUsers,
    setUserActive,
    listConversations,
    getConversation,
    saveConversation,
    deleteConversation,
    adminListConversations,
  };
}

/** Map a DB row to a public {@link AccountUser}. */
function rowToUser(row: Record<string, unknown>): AccountUser {
  return {
    id: String(row.id ?? ''),
    email: String(row.email ?? ''),
    role: row.role === 'superadmin' ? 'superadmin' : 'user',
    active: row.active !== false,
    createdAt: row.created_at !== undefined ? new Date(String(row.created_at)).toISOString() : new Date().toISOString(),
    createdBy: row.created_by !== undefined && row.created_by !== null ? String(row.created_by) : null,
  };
}

/** The accounts service type. */
export type AccountsService = ReturnType<typeof buildAccountsService>;
