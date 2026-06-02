'use client';

/**
 * Chat screen (Req 40.2).
 *
 * A conversation view with a scrollable message list and a composer. Messages
 * are loaded through the `@/lib/api` facade; sending appends the user message
 * and simulates a streaming assistant reply (a placeholder for the SDK's
 * `streamChat`) so the streaming UX is exercised without depending on the SDK's
 * final signature. Citations open the contextual side panel's sources view
 * (Req 40.5).
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ChatMessageView } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { useContextPanel } from '@/components/shell/ContextPanel';

/** Render a single message's text content (placeholder ignores multimodal parts). */
function messageText(view: ChatMessageView): string {
  const content = view.message.content;
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => (part.type === 'text' ? part.text : '[image]'))
    .join(' ');
}

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);
  const { setView } = useContextPanel();

  useEffect(() => {
    let active = true;
    void api.getMessages().then((loaded) => {
      if (active) setMessages(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (text.length === 0 || streaming) {
      return;
    }
    const userMessage: ChatMessageView = {
      id: `local-${Date.now()}`,
      createdAt: new Date().toISOString(),
      message: { role: 'user', content: text },
    };
    setMessages((prev) => [...prev, userMessage]);
    setDraft('');

    // Simulate a streamed assistant reply (placeholder for SDK streamChat).
    setStreaming(true);
    const replyId = `local-${Date.now()}-a`;
    const full = 'Thanks — this is a placeholder streamed response wired through the local API facade.';
    const words = full.split(' ');
    setMessages((prev) => [
      ...prev,
      { id: replyId, createdAt: new Date().toISOString(), model: 'gpt-4o', message: { role: 'assistant', content: '' } },
    ]);
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      const partial = words.slice(0, index).join(' ');
      setMessages((prev) =>
        prev.map((m) => (m.id === replyId ? { ...m, message: { ...m.message, content: partial } } : m)),
      );
      if (index >= words.length) {
        window.clearInterval(timer);
        setStreaming(false);
      }
    }, 60);
  }

  return (
    <div className="page" style={{ height: '100%' }}>
      <PageHeader title="Chat" subtitle="Converse with AI models and cite your sources." />
      <div className="chat">
        <div className="chat__messages" aria-live="polite" aria-label="Conversation">
          {messages.map((view) => (
            <div
              key={view.id}
              className={`message message--${view.message.role === 'user' ? 'user' : 'assistant'}`}
            >
              <span className="message__role">
                {view.message.role}
                {view.model ? ` · ${view.model}` : ''}
              </span>
              <span>{messageText(view) || (streaming ? '…' : '')}</span>
              {view.attribution && view.attribution.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  style={{ alignSelf: 'flex-start', padding: 'var(--space-1) var(--space-2)' }}
                  onClick={() => setView('sources')}
                >
                  <span className="badge badge--accent">{view.attribution.length} sources</span>
                </button>
              ) : null}
            </div>
          ))}
          <div ref={listEndRef} />
        </div>

        <form className="composer" onSubmit={handleSend} aria-label="Message composer">
          <label htmlFor="chat-composer" className="sr-only">
            Type a message
          </label>
          <input
            id="chat-composer"
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Send a message…"
            autoComplete="off"
          />
          <button type="submit" className="btn btn--primary" disabled={streaming || draft.trim().length === 0}>
            {streaming ? 'Sending…' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
