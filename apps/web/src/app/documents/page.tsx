import { api } from '@/lib/api';
import type { DocumentSummary } from '@/lib/api';
import { PageHeader } from '@/components/ui/PageHeader';

/**
 * Document Management screen (Req 40.2).
 *
 * Lists managed files/documents in a data table with name, type, size, upload
 * date, and indexing status, loaded through the `@/lib/api` facade.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadgeClass(status: DocumentSummary['status']): string {
  switch (status) {
    case 'indexed':
      return 'badge badge--success';
    case 'processing':
      return 'badge badge--warning';
    case 'failed':
      return 'badge badge--danger';
  }
}

export default async function DocumentsPage() {
  const documents = await api.listDocuments();

  return (
    <div className="page">
      <PageHeader
        title="Document Management"
        subtitle="Upload, organize, and manage files and documents."
        actions={
          <button type="button" className="btn btn--primary">
            <span aria-hidden="true">＋</span> Upload
          </button>
        }
      />
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="table">
          <caption className="sr-only">Managed documents</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Size</th>
              <th scope="col">Uploaded</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.name}</td>
                <td className="subtle">{doc.mimeType}</td>
                <td>{formatBytes(doc.sizeBytes)}</td>
                <td>
                  <time dateTime={doc.uploadedAt}>{new Date(doc.uploadedAt).toLocaleDateString()}</time>
                </td>
                <td>
                  <span className={statusBadgeClass(doc.status)}>{doc.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
