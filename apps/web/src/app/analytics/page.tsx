import { api } from '@/lib/api';
import type { MetricCard } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Analytics Dashboard screen (Req 40.2).
 *
 * Renders metric cards (usage, cost, adoption) loaded through the `@/lib/api`
 * facade, each showing a value and a period-over-period delta with an
 * accessible trend indicator.
 */
function trendGlyph(trend: MetricCard['trend']): string {
  switch (trend) {
    case 'up':
      return '▲';
    case 'down':
      return '▼';
    case 'flat':
      return '—';
  }
}

function trendLabel(trend: MetricCard['trend']): string {
  switch (trend) {
    case 'up':
      return 'trending up';
    case 'down':
      return 'trending down';
    case 'flat':
      return 'no change';
  }
}

export default async function AnalyticsPage() {
  const metrics = await api.getMetrics();

  return (
    <div className="page">
      <PageHeader
        title="Analytics"
        subtitle="Usage, cost, and adoption metrics across the platform."
      />
      <div className="grid grid--metrics" role="list" aria-label="Key metrics">
        {metrics.map((metric) => (
          <article key={metric.id} className="card" role="listitem">
            <p className="card__meta">{metric.label}</p>
            <p style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, margin: 'var(--space-1) 0' }}>
              {metric.value}
            </p>
            <p className="row" style={{ gap: 'var(--space-1)', margin: 0 }}>
              <span aria-hidden="true">{trendGlyph(metric.trend)}</span>
              <span>{metric.delta}</span>
              <span className="sr-only">{trendLabel(metric.trend)}</span>
            </p>
          </article>
        ))}
      </div>

      <section className="card" style={{ marginTop: 'var(--space-5)' }} aria-labelledby="usage-trend-title">
        <h2 id="usage-trend-title" className="card__title">
          Usage over time
        </h2>
        <p className="muted">
          A detailed time-series chart will render here once the analytics SDK endpoints are wired.
        </p>
      </section>
    </div>
  );
}
