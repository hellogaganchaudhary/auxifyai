import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Knowledge Hub screen (Req 40.2).
 *
 * An async server component listing curated knowledge collections loaded
 * through the `@/lib/api` facade. Each collection card shows its document and
 * source counts.
 */
export default async function KnowledgeHubPage() {
  const collections = await api.listKnowledgeCollections();

  return (
    <div className="page">
      <PageHeader
        title="Knowledge Hub"
        subtitle="Curated collections, pages, and connected knowledge sources."
      />
      <div className="grid grid--cards" role="list" aria-label="Knowledge collections">
        {collections.map((collection) => (
          <article key={collection.id} className="card" role="listitem">
            <h2 className="card__title">{collection.name}</h2>
            <p className="muted">{collection.description}</p>
            <div className="row row--wrap" style={{ gap: 'var(--space-2)' }}>
              <span className="badge">{collection.documentCount} documents</span>
              <span className="badge">{collection.sourceCount} sources</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
