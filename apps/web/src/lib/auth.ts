/**
 * Client-side authentication for the single shared application login.
 *
 * Credentials are validated SERVER-SIDE (`POST /v1/auth/login`) so the password
 * never lives in the browser bundle. On success the server returns an opaque
 * session token, which we persist in `localStorage` to keep the user signed in
 * across reloads. This gates the UI; the API itself is additionally protected
 * by its own key.
 */

import { API_BASE_URL } from './config';

/** localStorage key under which the session token is stored. */
const TOKEN_KEY = 'auxify.session.token';
/** localStorage key under which the signed-in email is stored (for display). */
const EMAIL_KEY = 'auxify.session.email';

/** The result of a successful login. */
export interface Session {
  token: string;
  email: string;
}

/** Validate credentials against the API and persist the session on success. */
export async function login(email: string, password: string): Promise<Session> {
  const response = await fetch(`${API_BASE_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = (await response.json()) as { token?: string; email?: string; error?: string };
  if (!response.ok || data.token === undefined) {
    throw new Error(data.error ?? `login failed (${response.status})`);
  }
  const session: Session = { token: data.token, email: data.email ?? email };
  try {
    window.localStorage.setItem(TOKEN_KEY, session.token);
    window.localStorage.setItem(EMAIL_KEY, session.email);
  } catch {
    /* storage unavailable (private mode) — session lives for this tab only */
  }
  return session;
}

/** The current persisted session, or null when signed out. */
export function getSession(): Session | null {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY);
    const email = window.localStorage.getItem(EMAIL_KEY) ?? '';
    return token !== null && token.length > 0 ? { token, email } : null;
  } catch {
    return null;
  }
}

/** Whether a user is currently signed in. */
export function isAuthenticated(): boolean {
  return getSession() !== null;
}

/** Clear the persisted session (sign out). */
export function logout(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(EMAIL_KEY);
  } catch {
    /* ignore */
  }
}
