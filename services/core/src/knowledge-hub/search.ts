/**
 * The pure space-scoped page search core (Req 26.x search within a space).
 *
 * {@link searchPages} ranks a Project space's pages against a free-text query by
 * a simple contains-score over the page title and body text. This is the
 * Knowledge_Hub's own listing/search within a space; the platform's authorized
 * combined keyword + vector retrieval across all content is the
 * Unified_Search_Service (Req 29). Keeping this pure (over an already
 * tenant-scoped page list) makes the ranking directly unit-testable.
 */

import type { KnowledgePage, PageSearchHit } from './types.js';

/** Count non-overlapping occurrences of `needle` in `haystack` (both lowercased). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Rank `pages` against `query`, returning the matching pages most-relevant
 * first (Req 26.x).
 *
 * A title match is weighted more heavily than a body match. Pages that match
 * neither title nor body are excluded. An empty/whitespace query returns no
 * hits. Ties break by title then id so the ordering is deterministic.
 *
 * @param pages The Project space's pages (already tenant-scoped).
 * @param query The free-text query.
 * @returns The matching {@link PageSearchHit}s, most-relevant first.
 */
export function searchPages(pages: readonly KnowledgePage[], query: string): PageSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const hits: PageSearchHit[] = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const body = page.content.text.toLowerCase();
    const titleHits = countOccurrences(title, needle);
    const bodyHits = countOccurrences(body, needle);
    if (titleHits === 0 && bodyHits === 0) continue;
    // Title matches dominate body matches.
    const score = titleHits * 10 + bodyHits;
    hits.push({
      page,
      score,
      titleMatch: titleHits > 0,
      bodyMatch: bodyHits > 0,
    });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.page.title.toLowerCase();
    const bt = b.page.title.toLowerCase();
    if (at < bt) return -1;
    if (at > bt) return 1;
    if (a.page.id < b.page.id) return -1;
    if (a.page.id > b.page.id) return 1;
    return 0;
  });

  return hits;
}
