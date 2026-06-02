import { api } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Knowledge Base screen (Req 40.2).
 *
 * Lists indexed knowledge-base documents and their chunk counts in a data
 * table, loaded through the `@/lib/api` facade. These entries power retrieval
 * for chat and search.
 */
export default async function KnowledgeBasePage() {
  const entries = await api.listKnowledgeBase();

  return (
    <div className="page">
      <PageHeader
        title="Knowledge Base"
        subtitle="Indexed documents and chunks powering retrieval."
      />
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <caption className="sr-only">Indexed knowledge documents</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Collection</th>
              <th scope="col">Chunks</th>
              <th scope="col">Indexed</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} id={entry.id}>
                <td>{entry.title}</td>
                <td className="subtle">{entry.collection}</td>
                <td>{entry.chunkCount}</td>
                <td>
                  <time dateTime={entry.indexedAt}>{new Date(entry.indexedAt).toLocaleDateString()}</time>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
