/**
 * Client-side authentication for the multi-user platform.
 *
 * Credentials are validated SERVER-SIDE (`POST /v1/auth/login`); on success the
 * server returns a signed session token plus the user (email + role). The token
 * is sent as a Bearer header on per-user API calls (conversations, admin) and
 * persisted so the session survives reloads.
 */

import { API_BASE_URL } from './config';

const TOKEN_KEY = 'auxify.session.token';
const USER_KEY = 'auxify.session.user';

/** The signed-in user. */
export interface SessionUser {
  id?: string;
  email: string;
  role: 'superadmin' | 'user';
}

/** A persisted session. */
export interface Session {
  token: string;
  user: SessionUser;
}

/** Validate credentials against the API and persist the session on success. */
export async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${API_BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await response.json()) as { token?: string; user?: SessionUser; email?: string; error?: string };
  if (!response.ok || data.token === undefined) {
    throw new Error(data.error ?? `login failed (${response.status})`);
  }
  const user: SessionUser = data.user ?? { email, role: 'user' };
  const session: Session = { token: data.token, user };
  try {
    window.localStorage.setItem(TOKEN_KEY, session.token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  } catch {
    /* storage unavailable — session lives for this tab only */
  }
  return session;
}

/** The current persisted session, or null when signed out. */
export function getSession(): Session | null {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    if (token === null || token.length === 0) return null;
    const rawUser = window.localStorage.getItem(USER_KEY);
    const user = rawUser !== null ? (JSON.parse(rawUser) as SessionUser) : { email: '', role: 'user' as const };
    return { token, user };
  } catch {
    return null;
  }
}

/** Whether a user is currently signed in. */
export function isAuthenticated(): boolean {
  return getSession() !== null;
}

/** The current user's role, or null. */
export function currentRole(): 'superadmin' | 'user' | null {
  return getSession()?.user.role ?? null;
}

/** Authorization header for per-user API calls (empty when signed out). */
export function authHeader(): Record<string, string> {
  const session = getSession();
  return session !== null ? { authorization: `Bearer ${session.token}` } : {};
}

/** Clear the persisted session (sign out). */
export function logout(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}
