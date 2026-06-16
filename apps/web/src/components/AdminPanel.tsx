'use client';

/**
 * Super-admin console — create users and monitor everyone's conversations.
 *
 * Only the super-admin (gaganchaudhary061506@gmail.com, seeded from the
 * backend) can open this. It lets the admin add team members (email = username,
 * password set here), see all users, and read any user's stored conversations.
 */

import { useEffect, useState } from 'react';

import {
  adminCreateUser,
  adminListUsers,
  adminListConversations,
  adminGetConversation,
  type AdminUser,
  type AdminConversation,
} from '@/lib/server-store';
import type { Conversation } from '@/lib/conversations';
import { Markdown } from '@/components/Markdown';

/** The admin console modal. */
export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'users' | 'monitor'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [convos, setConvos] = useState<AdminConversation[]>([]);
  const [viewing, setViewing] = useState<Conversation | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void refreshUsers();
  }, []);

  async function refreshUsers() {
    try {
      setUsers(await adminListUsers());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed to load users');
    }
  }

  async function refreshConvos() {
    try {
      setConvos(await adminListConversations());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'failed to load conversations');
    }
  }

  async function handleCreate() {
    if (email.trim().length === 0 || password.length < 6) {
      setError('Enter an email and a password of at least 6 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const user = await adminCreateUser(email.trim().toLowerCase(), password, 'user');
      setNotice(`Created ${user.email}. Share these credentials with the user.`);
      setEmail('');
      setPassword('');
      await refreshUsers();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'could not create user');
    } finally {
      setBusy(false);
    }
  }

  async function openConversation(id: string) {
    setError(null);
    try {
      setViewing(await adminGetConversation(id));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'could not open conversation');
    }
  }

  return (
    <div className="ax__usage-overlay" role="dialog" aria-modal="true" aria-label="Admin console" onClick={onClose}>
      <div className="ax__usage ax__knowledge" onClick={(e) => e.stopPropagation()}>
        <header className="ax__usage-head">
          <div>
            <h2 className="ax__usage-title">Admin console</h2>
            <p className="ax__usage-sub">Create users and monitor all conversations.</p>
          </div>
          <button type="button" className="ax__iconbtn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="ax__admin-tabs">
          <button
            type="button"
            className={`ax__admin-tab ${tab === 'users' ? 'ax__admin-tab--on' : ''}`}
            onClick={() => setTab('users')}
          >
            Users
          </button>
          <button
            type="button"
            className={`ax__admin-tab ${tab === 'monitor' ? 'ax__admin-tab--on' : ''}`}
            onClick={() => {
              setTab('monitor');
              void refreshConvos();
            }}
          >
            Monitor conversations
          </button>
        </div>

        {error ? <div className="ax__alert" role="status"><span className="ax__alert-msg">{error}</span></div> : null}
        {notice ? <div className="ax__voice-status">{notice}</div> : null}

        {tab === 'users' ? (
          <>
            <section className="ax__kb-add">
              <input
                className="ax__kb-input"
                placeholder="New user email (this is their username)"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
              />
              <input
                className="ax__kb-input"
                placeholder="Password (min 6 characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="text"
              />
              <button type="button" className="ax__kb-btn" onClick={() => void handleCreate()} disabled={busy}>
                {busy ? 'Creating…' : '＋ Create user'}
              </button>
            </section>
            <section className="ax__kb-section">
              <h3 className="ax__kb-h3">Users ({users.length})</h3>
              <ul className="ax__kb-list">
                {users.map((u) => (
                  <li key={u.id} className="ax__kb-item">
                    <span className="ax__kb-item-name">{u.email}</span>
                    <span className="ax__kb-item-meta">{u.role}{u.active ? '' : ' · disabled'}</span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : viewing !== null ? (
          <section className="ax__kb-section">
            <button type="button" className="ax__kb-btn" onClick={() => setViewing(null)}>← Back to list</button>
            <h3 className="ax__kb-h3">{viewing.title}</h3>
            <div className="ax__admin-convo">
              {viewing.messages.map((m) => (
                <div key={m.id} className={`ax__admin-msg ax__admin-msg--${m.role}`}>
                  <span className="ax__admin-msg-role">{m.role}</span>
                  <Markdown>{m.content || '(media / empty)'}</Markdown>
                  {m.images && m.images.length > 0 ? (
                    <div className="ax__media">
                      {m.images.map((src, i) => (
                        <img key={i} src={src} alt="" className="ax__media-item" />
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className="ax__kb-section">
            <h3 className="ax__kb-h3">All conversations ({convos.length})</h3>
            <ul className="ax__kb-list">
              {convos.map((c) => (
                <li key={c.id} className="ax__kb-item ax__kb-item--btn" onClick={() => void openConversation(c.id)}>
                  <span className="ax__kb-item-name">{c.title}</span>
                  <span className="ax__kb-item-meta">{c.email} · {new Date(c.updatedAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
