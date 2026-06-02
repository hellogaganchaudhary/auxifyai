'use client';

/**
 * Settings screen (Req 40.2, 40.4).
 *
 * Personal preferences, including the appearance/theme switch (light / dark /
 * system) rendered via the shared `ThemeToggle`, plus a read-out of which SDK
 * the client facade is connected to. A client component because it reads the
 * live theme state.
 */
import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';
import { ThemeToggle } from '@/components/shell/ThemeToggle';
import { useTheme } from '@/components/shell/ThemeProvider';
import { themeLabel } from '@/lib/theme';

export default function SettingsPage() {
  const { preference, resolved } = useTheme();

  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Personal preferences and appearance." />

      <section className="card" aria-labelledby="appearance-title" style={{ marginBottom: 'var(--space-4)' }}>
        <h2 id="appearance-title" className="card__title">
          Appearance
        </h2>
        <p className="muted">Choose how Auxify looks. System follows your operating system.</p>
        <div className="row row--between row--wrap">
          <ThemeToggle />
          <p className="subtle" aria-live="polite" style={{ margin: 0 }}>
            Selected: {themeLabel(preference)} · applied: {resolved}
          </p>
        </div>
      </section>

      <section className="card" aria-labelledby="connection-title">
        <h2 id="connection-title" className="card__title">
          Connection
        </h2>
        <dl className="grid" style={{ gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-2)' }}>
          <dt className="subtle">SDK package</dt>
          <dd style={{ margin: 0 }}>
            <code className="kbd">{api.connectedSdk}</code>
          </dd>
        </dl>
      </section>
    </div>
  );
}
