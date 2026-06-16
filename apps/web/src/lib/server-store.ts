/**
 * Server-backed persistence for conversations + admin operations.
 *
 * Conversations (with every message, response, and media) are stored per user
 * in the backend so they never vanish and appear in the account on any device.
 * The super-admin endpoints let the main user create accounts and monitor
 * everyone's conversations. All calls carry the Bearer session token.
 */

import { API_BASE_URL } from './config';
import { authHeader } from './auth';
import { retryAsync } from './chat-client';
import type { Conversation } from './conversations';

/** A user as returned by the admin API. */
export interface AdminUser {
  id: string;
  email: string;
  role: 'superadmin' | 'user';
  active: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** A conversation summary (no payload). */
export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** An admin conversation row (with owner). */
export interface AdminConversation extends ConversationSummary {
  userId: string;
  email: string;
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', ...authHeader() };
}

/** The current signed-in user, resolved authoritatively from the server. */
export async function getMe(): Promise<{ id: string; email: string; role: 'superadmin' | 'user' } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/v1/auth/me`, { headers: headers() });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: { id: string; email: string; role: 'superadmin' | 'user' } };
    return data.user ?? null;
  } catch {
    return null;
  }
}

/** List the signed-in user's conversation summaries. */
export async function listServerConversations(): Promise<ConversationSummary[]> {
  const res = await fetch(`${API_BASE_URL}/v1/conversations`, { headers: headers() });
  if (!res.ok) throw new Error(`failed to list conversations (${res.status})`);
  const data = (await res.json()) as { conversations?: ConversationSummary[] };
  return data.conversations ?? [];
}

/** Fetch one conversation's full payload (own). */
export async function getServerConversation(id: string): Promise<Conversation | null> {
  const res = await fetch(`${API_BASE_URL}/v1/conversations/${encodeURIComponent(id)}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`failed to load conversation (${res.status})`);
  const data = (await res.json()) as { conversation?: Conversation };
  return data.conversation ?? null;
}

/**
 * Save (upsert) a conversation to the server. Retried so a transient failure
 * never loses history; fire-and-forget safe (callers ignore the result).
 */
export async function saveServerConversation(conversation: Conversation): Promise<void> {
  await retryAsync(
    async () => {
      const res = await fetch(`${API_BASE_URL}/v1/conversations`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ conversation }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
    },
    { attempts: 5, baseDelayMs: 2000 },
  );
}

/** Delete a conversation on the server. */
export async function deleteServerConversation(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/v1/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
  } catch {
    /* best-effort */
  }
}

/* ── Admin (super-admin only) ─────────────────────────────────────────────── */

/** List all users. */
export async function adminListUsers(): Promise<AdminUser[]> {
  const res = await fetch(`${API_BASE_URL}/v1/admin/users`, { headers: headers() });
  if (!res.ok) throw new Error(`failed to list users (${res.status})`);
  const data = (await res.json()) as { users?: AdminUser[] };
  return data.users ?? [];
}

/** Create a new user (email = username). */
export async function adminCreateUser(
  email: string,
  password: string,
  role: 'superadmin' | 'user' = 'user',
): Promise<AdminUser> {
  const res = await fetch(`${API_BASE_URL}/v1/admin/users`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ email, password, role }),
  });
  const data = (await res.json()) as { user?: AdminUser; error?: string };
  if (!res.ok || data.user === undefined) throw new Error(data.error ?? `failed to create user (${res.status})`);
  return data.user;
}

/** List every conversation across all users (with owner email). */
export async function adminListConversations(): Promise<AdminConversation[]> {
  const res = await fetch(`${API_BASE_URL}/v1/admin/conversations`, { headers: headers() });
  if (!res.ok) throw new Error(`failed to list conversations (${res.status})`);
  const data = (await res.json()) as { conversations?: AdminConversation[] };
  return data.conversations ?? [];
}

/** Read any user's conversation (admin). */
export async function adminGetConversation(id: string): Promise<Conversation | null> {
  const res = await fetch(`${API_BASE_URL}/v1/admin/conversations/${encodeURIComponent(id)}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`failed to load conversation (${res.status})`);
  const data = (await res.json()) as { conversation?: Conversation };
  return data.conversation ?? null;
}
