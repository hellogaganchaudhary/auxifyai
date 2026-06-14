'use client';

/**
 * Gates the app behind the single shared application login. Until a valid
 * session exists, it renders the sign-in screen; once signed in, it renders the
 * protected children. Credentials are checked server-side (see `lib/auth`).
 */

import { useEffect, useState, type ReactNode } from 'react';

import { getSession, login } from '@/lib/auth';
import { BrandMark } from '@/components/brand/Logo';

/** The email/password sign-in screen. */
function LoginScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      onSignedIn();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ax__login">
      <form className="ax__login-card" onSubmit={(e) => void submit(e)}>
        <div className="ax__login-brand">
          <BrandMark size={40} />
          <span className="ax__login-name">Auxify</span>
        </div>
        <h1 className="ax__login-title">Sign in</h1>
        <p className="ax__login-sub">Enter your credentials to access the workspace.</p>

        {error ? <div className="ax__login-error" role="alert">{error}</div> : null}

        <label className="ax__login-label" htmlFor="ax-login-email">Email</label>
        <input
          id="ax-login-email"
          className="ax__login-input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />

        <label className="ax__login-label" htmlFor="ax-login-pass">Password</label>
        <input
          id="ax-login-pass"
          className="ax__login-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />

        <button type="submit" className="ax__login-btn" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/** Render `children` only when signed in; otherwise show the login screen. */
export function AuthGate({ children }: { children: ReactNode }) {
  // `null` = not yet hydrated (avoids a flash of the wrong UI on first paint).
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(getSession() !== null);
  }, []);

  if (authed === null) {
    return <div className="ax__login" aria-busy="true" />;
  }
  if (!authed) {
    return <LoginScreen onSignedIn={() => setAuthed(true)} />;
  }
  return <>{children}</>;
}
