import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Team Communication screen (Req 40.2).
 *
 * Messaging surface showing the list of channels alongside a sample channel
 * thread, both loaded through the `@/lib/api` facade. Built as a two-column
 * layout with a `<nav>` channel list and the message thread as the main region.
 */
export default async function TeamCommunicationPage() {
  const [channels, messages] = await Promise.all([
    api.listChannels(),
    api.getChannelMessages(),
  ]);

  return (
    <div className="page">
      <PageHeader title="Team Communication" subtitle="Channels and direct messages for your team." />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr)' }}>
        <nav aria-label="Channels" className="card" style={{ padding: 'var(--space-2)' }}>
          <ul className="list-plain">
            {channels.map((channel) => (
              <li key={channel.id}>
                <a
                  href={`#channel-${channel.id}`}
                  className="sidebar__link"
                  title={channel.topic}
                >
                  <span className="sidebar__glyph" aria-hidden="true">
                    #
                  </span>
                  <span style={{ flex: 1 }}>{channel.name}</span>
                  {channel.unread > 0 ? (
                    <span className="badge badge--accent" aria-label={`${channel.unread} unread`}>
                      {channel.unread}
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <section className="card" aria-label="Channel messages">
          <h2 className="card__title">#engineering</h2>
          <ul className="list-plain stack" style={{ marginTop: 'var(--space-3)' }}>
            {messages.map((message) => (
              <li key={message.id} className="stack" style={{ gap: 2 }}>
                <span className="row" style={{ gap: 'var(--space-2)' }}>
                  <strong>{message.author}</strong>
                  <time className="card__meta" dateTime={message.sentAt}>
                    {new Date(message.sentAt).toLocaleString()}
                  </time>
                </span>
                <span>{message.body}</span>
              </li>
            ))}
          </ul>
          <form className="composer" aria-label="Send a channel message">
            <label htmlFor="channel-composer" className="sr-only">
              Message #engineering
            </label>
            <input id="channel-composer" className="input" placeholder="Message #engineering…" autoComplete="off" />
            <button type="submit" className="btn btn--primary">
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
