import { Suspense } from 'react';
import { PageHeader } from '@/components/ui/PageHeader';
import { SearchClient } from './SearchClient';

/**
 * Unified Search screen (Req 40.2).
 *
 * A server component shell that renders the page header and wraps the
 * interactive `SearchClient` in a `<Suspense>` boundary — required by Next 15
 * because the client reads `useSearchParams()` to seed the query from the URL
 * (e.g. when the shell header submits `/search?q=…`).
 */
export default function SearchPage() {
  return (
    <div className="page">
      <PageHeader
        title="Unified Search"
        subtitle="Search across conversations, knowledge, documents, and the web."
      />
      <Suspense fallback={<p className="subtle">Loading search…</p>}>
        <SearchClient />
      </Suspense>
    </div>
  );
}
