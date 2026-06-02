'use client';

/**
 * Interactive unified-search client (Req 40.2, 40.5).
 *
 * Seeds its query from the `q` URL parameter, runs searches through the
 * `@/lib/api` facade, and groups results by source surface (conversation,
 * knowledge, document, web). Results that carry attribution can reveal it,
 * mirroring the source-attribution view of the contextual side panel.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import type { SearchResult } from '@/lib/api';

const SOURCE_LABELS: Record<SearchResult['source'], string> = {
  conversation: 'Conversations',
  knowledge: 'Knowledge',
  document: 'Documents',
  web: 'Web',
};

export function SearchClient() {
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get('q') ?? '';
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.unifiedSearch(query).then((found) => {
      if (!active) return;
      setResults(found);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [query]);

  const grouped = (Object.keys(SOURCE_LABELS) as SearchResult['source'][])
    .map((source) => ({ source, items: results.filter((result) => result.source === source) }))
    .filter((group) => group.items.length > 0);

  return (
    <>
      <form
        role="search"
        className="row"
        style={{ marginBottom: 'var(--space-5)' }}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setQuery(String(data.get('q') ?? ''));
        }}
      >
        <label htmlFor="unified-search" className="sr-only">
          Search query
        </label>
        <input
          id="unified-search"
          name="q"
          type="search"
          className="input"
          defaultValue={initialQuery}
          placeholder="Search across everything…"
        />
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </form>

      {loading ? <p className="subtle">Searching…</p> : null}
      {!loading && results.length === 0 ? <p className="muted">No results found.</p> : null}

      <div className="stack" style={{ gap: 'var(--space-5)' }}>
        {grouped.map((group) => (
          <section key={group.source} aria-labelledby={`results-${group.source}`}>
            <h2 id={`results-${group.source}`}>{SOURCE_LABELS[group.source]}</h2>
            <ul className="list-plain stack">
              {group.items.map((result) => (
                <li key={result.id} className="card">
                  <a href={result.link} className="card__title">
                    {result.title}
                  </a>
                  <p className="muted">{result.snippet}</p>
                  {result.attribution ? (
                    <p className="card__meta">
                      Source: {result.attribution.sourceTitle} ({result.attribution.location})
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
