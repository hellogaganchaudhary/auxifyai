import Link from 'next/link';
import { AUXIFY_SDK_PACKAGE } from '@auxify/sdk';
import { AUXIFY_TYPES_PACKAGE } from '@auxify/types';
import { FEATURE_NAV_ITEMS } from '@/lib/navigation';

/**
 * Home dashboard / landing screen.
 *
 * A server component that introduces the workspace and links into all twelve
 * feature screens (Req 40.2) via cards built from the shared navigation
 * registry, so the home page and sidebar can never drift. It also confirms the
 * linked workspace packages resolve.
 */
export default function HomePage() {
  return (
    <div className="page">
      <section className="hero" aria-labelledby="home-title">
        <h1 id="home-title">Welcome to Auxify</h1>
        <p className="muted" style={{ maxWidth: 640 }}>
          Your enterprise AI workspace — chat with models, search across every source, build and
          monitor agents, and manage knowledge and teams from one place.
        </p>
        <p className="subtle">
          Linked packages: {AUXIFY_SDK_PACKAGE}, {AUXIFY_TYPES_PACKAGE}
        </p>
      </section>

      <h2>Jump back in</h2>
      <div className="grid grid--cards" role="list" aria-label="Workspaces">
        {FEATURE_NAV_ITEMS.map((item) => (
          <Link key={item.id} href={item.href} className="card" role="listitem">
            <div className="row" style={{ marginBottom: 'var(--space-2)' }}>
              <span aria-hidden="true" style={{ fontSize: 'var(--text-xl)' }}>
                {item.glyph}
              </span>
              <span className="card__title">{item.label}</span>
            </div>
            <p className="muted" style={{ margin: 0 }}>
              {item.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
