/**
 * Unit tests for the Unified_Search_Service (Req 29.1-29.7).
 *
 * These exercise the full search surface against the in-memory fakes in
 * `./fakes.js` — no real Knowledge_Hub, Messaging, Document_Management, or
 * Conversation service:
 *
 *  - fan-out across content types with results grouped by type (Req 29.1, 29.3);
 *  - in-group ranking by non-increasing relevance, fusing keyword + vector
 *    scores (Req 29.3, 29.6);
 *  - the per-group top-K bound (Req 29.3);
 *  - only authorized results returned (Req 29.2);
 *  - tenant isolation — never another Organization's content (Req 1.2);
 *  - content-type filtering (Req 29.4), including the unknown-type rejection;
 *  - source-module location on every result (Req 29.5);
 *  - graceful degradation: an unavailable searcher is reported as an unsearched
 *    type while the available types still return results (Req 29.7).
 */

import { describe, expect, it } from 'vitest';

import {
  AllowAllAuthorizer,
  DenyListAuthorizer,
  FakeContentTypeSearcher,
  TEST_ORG,
  makeCandidate,
  makePrincipal,
} from './fakes.js';
import { UnknownContentTypeFilterError } from './errors.js';
import { UnifiedSearchService } from './unified-search-service.js';
import type { UnifiedSearchGroup, UnifiedSearchType } from './types.js';

/** Find the group for a content type in a result, or `undefined` when absent. */
function groupOf(
  groups: readonly UnifiedSearchGroup[],
  type: UnifiedSearchType,
): UnifiedSearchGroup | undefined {
  return groups.find((group) => group.type === type);
}

describe('search — fan-out and grouping (Req 29.1, 29.3)', () => {
  it('groups results by content type across every registered searcher', async () => {
    const pages = new FakeContentTypeSearcher('knowledge_page', [
      makeCandidate({ id: 'p1', keywordScore: 0.8, vectorScore: 0.8 }),
    ]);
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'd1', keywordScore: 0.6, vectorScore: 0.6 }),
    ]);
    const messages = new FakeContentTypeSearcher('message', [
      makeCandidate({ id: 'm1', keywordScore: 0.7, vectorScore: 0.7 }),
    ]);
    const service = new UnifiedSearchService({
      searchers: [pages, docs, messages],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('quarterly plan', makePrincipal());

    expect(result.groups.map((g) => g.type).sort()).toEqual(
      ['document', 'knowledge_page', 'message'].sort(),
    );
    expect(groupOf(result.groups, 'knowledge_page')?.items.map((i) => i.id)).toEqual(['p1']);
    expect(groupOf(result.groups, 'document')?.items.map((i) => i.id)).toEqual(['d1']);
    // Every selected searcher was invoked with the query (Req 29.1).
    expect(pages.queries).toEqual(['quarterly plan']);
    expect(docs.queries).toEqual(['quarterly plan']);
    expect(messages.queries).toEqual(['quarterly plan']);
    // Every returned result carries its content type tag (Req 29.3).
    for (const group of result.groups) {
      for (const item of group.items) {
        expect(item.type).toBe(group.type);
      }
    }
  });

  it('omits a content type that produced no results', async () => {
    const pages = new FakeContentTypeSearcher('knowledge_page', [makeCandidate({ id: 'p1' })]);
    const docs = new FakeContentTypeSearcher('document', []); // no matches
    const service = new UnifiedSearchService({
      searchers: [pages, docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('anything', makePrincipal());

    expect(result.groups.map((g) => g.type)).toEqual(['knowledge_page']);
    expect(result.unavailableTypes).toEqual([]);
  });
});

describe('search — in-group ranking (Req 29.3, 29.6)', () => {
  it('ranks results within a group by non-increasing relevance', async () => {
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'low', keywordScore: 0.1, vectorScore: 0.1 }),
      makeCandidate({ id: 'high', keywordScore: 0.95, vectorScore: 0.95 }),
      makeCandidate({ id: 'mid', keywordScore: 0.5, vectorScore: 0.5 }),
    ]);
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('budget', makePrincipal());
    const items = groupOf(result.groups, 'document')!.items;

    expect(items.map((i) => i.id)).toEqual(['high', 'mid', 'low']);
    const scores = items.map((i) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('fuses keyword and vector scores into the ranking score (Req 29.6)', async () => {
    // Equal vector scores; the higher keyword overlap must rank first.
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'kw-weak', keywordScore: 0.1, vectorScore: 0.5 }),
      makeCandidate({ id: 'kw-strong', keywordScore: 0.9, vectorScore: 0.5 }),
    ]);
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('budget', makePrincipal());
    const items = groupOf(result.groups, 'document')!.items;

    expect(items[0]!.id).toBe('kw-strong');
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score);
    // The fused score reflects both components.
    expect(items[0]!.keywordScore).toBe(0.9);
    expect(items[0]!.vectorScore).toBe(0.5);
  });

  it('breaks score ties deterministically on id', async () => {
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'b', keywordScore: 0.5, vectorScore: 0.5 }),
      makeCandidate({ id: 'a', keywordScore: 0.5, vectorScore: 0.5 }),
      makeCandidate({ id: 'c', keywordScore: 0.5, vectorScore: 0.5 }),
    ]);
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('tie', makePrincipal());
    expect(groupOf(result.groups, 'document')!.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('search — per-group top-K bound (Req 29.3)', () => {
  it('never returns more than the configured per-group limit, keeping the highest-ranked', async () => {
    const docs = new FakeContentTypeSearcher(
      'document',
      Array.from({ length: 8 }, (_unused, index) =>
        makeCandidate({
          id: `d${index}`,
          keywordScore: index / 10,
          vectorScore: index / 10,
        }),
      ),
    );
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
      defaultGroupLimit: 3,
    });

    const result = await service.search('many', makePrincipal());
    const items = groupOf(result.groups, 'document')!.items;

    expect(items).toHaveLength(3);
    // The three highest-scored candidates (d7, d6, d5) survive the bound.
    expect(items.map((i) => i.id)).toEqual(['d7', 'd6', 'd5']);
  });

  it('honors a per-query group limit override', async () => {
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'd1', keywordScore: 0.9, vectorScore: 0.9 }),
      makeCandidate({ id: 'd2', keywordScore: 0.8, vectorScore: 0.8 }),
      makeCandidate({ id: 'd3', keywordScore: 0.7, vectorScore: 0.7 }),
    ]);
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('limit', makePrincipal(), { groupLimit: 1 });
    expect(groupOf(result.groups, 'document')!.items.map((i) => i.id)).toEqual(['d1']);
  });
});

describe('search — authorization filtering (Req 29.2)', () => {
  it('excludes results the principal is not authorized to access', async () => {
    const messages = new FakeContentTypeSearcher('message', [
      makeCandidate({ id: 'visible', keywordScore: 0.6, vectorScore: 0.6 }),
      makeCandidate({ id: 'private', keywordScore: 0.95, vectorScore: 0.95 }),
    ]);
    const authorizer = new DenyListAuthorizer().deny('message', 'private');
    const service = new UnifiedSearchService({ searchers: [messages], authorizer });

    const result = await service.search('standup', makePrincipal());

    expect(groupOf(result.groups, 'message')!.items.map((i) => i.id)).toEqual(['visible']);
  });

  it('omits a content type whose every result is unauthorized', async () => {
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'd1' }),
      makeCandidate({ id: 'd2' }),
    ]);
    const authorizer = new DenyListAuthorizer().deny('document', 'd1').deny('document', 'd2');
    const service = new UnifiedSearchService({ searchers: [docs], authorizer });

    const result = await service.search('secret', makePrincipal());

    expect(result.groups).toEqual([]);
    expect(result.unavailableTypes).toEqual([]);
  });
});

describe('search — tenant isolation (Req 1.2)', () => {
  it('never returns another Organization\u2019s content even if a searcher leaks it', async () => {
    const docs = new FakeContentTypeSearcher('document', [
      makeCandidate({ id: 'mine', organizationId: TEST_ORG, keywordScore: 0.5, vectorScore: 0.5 }),
      makeCandidate({
        id: 'theirs',
        organizationId: 'org-other',
        keywordScore: 0.99,
        vectorScore: 0.99,
      }),
    ]);
    // Authorizer would allow everything; tenant scoping must still drop the foreign result.
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('shared', makePrincipal({ organizationId: TEST_ORG }));

    expect(groupOf(result.groups, 'document')!.items.map((i) => i.id)).toEqual(['mine']);
  });
});

describe('search — content-type filter (Req 29.4)', () => {
  it('restricts the search to the selected content types', async () => {
    const pages = new FakeContentTypeSearcher('knowledge_page', [makeCandidate({ id: 'p1' })]);
    const docs = new FakeContentTypeSearcher('document', [makeCandidate({ id: 'd1' })]);
    const messages = new FakeContentTypeSearcher('message', [makeCandidate({ id: 'm1' })]);
    const service = new UnifiedSearchService({
      searchers: [pages, docs, messages],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('plan', makePrincipal(), {
      types: ['document', 'knowledge_page'],
    });

    expect(result.groups.map((g) => g.type).sort()).toEqual(['document', 'knowledge_page']);
    // The unselected searcher was never invoked.
    expect(messages.queries).toEqual([]);
    expect(pages.queries).toEqual(['plan']);
    expect(docs.queries).toEqual(['plan']);
  });

  it('rejects a filter naming a content type with no registered searcher', async () => {
    const docs = new FakeContentTypeSearcher('document', [makeCandidate({ id: 'd1' })]);
    const service = new UnifiedSearchService({
      searchers: [docs],
      authorizer: new AllowAllAuthorizer(),
    });

    await expect(
      service.search('plan', makePrincipal(), { types: ['conversation'] }),
    ).rejects.toBeInstanceOf(UnknownContentTypeFilterError);
  });

  it('searches all types when the filter is empty', async () => {
    const pages = new FakeContentTypeSearcher('knowledge_page', [makeCandidate({ id: 'p1' })]);
    const docs = new FakeContentTypeSearcher('document', [makeCandidate({ id: 'd1' })]);
    const service = new UnifiedSearchService({
      searchers: [pages, docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('plan', makePrincipal(), { types: [] });
    expect(result.groups.map((g) => g.type).sort()).toEqual(['document', 'knowledge_page']);
  });
});

describe('search — source-module location (Req 29.5)', () => {
  it('returns the location needed to open each result in its source module', async () => {
    const location = {
      module: 'knowledge_hub',
      resourceType: 'knowledge_page',
      resourceId: 'page-42',
      url: '/knowledge/pages/page-42',
    };
    const pages = new FakeContentTypeSearcher('knowledge_page', [
      makeCandidate({ id: 'page-42', location, keywordScore: 0.7, vectorScore: 0.7 }),
    ]);
    const service = new UnifiedSearchService({
      searchers: [pages],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('runbook', makePrincipal());

    expect(groupOf(result.groups, 'knowledge_page')!.items[0]!.location).toEqual(location);
  });
});

describe('search — graceful degradation (Req 29.7)', () => {
  it('returns available results and names the content types that could not be searched', async () => {
    const pages = new FakeContentTypeSearcher('knowledge_page', [
      makeCandidate({ id: 'p1', keywordScore: 0.6, vectorScore: 0.6 }),
    ]);
    const docs = new FakeContentTypeSearcher('document', [makeCandidate({ id: 'd1' })]);
    docs.setAvailable(false); // the document source is down

    const service = new UnifiedSearchService({
      searchers: [pages, docs],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('outage', makePrincipal());

    // Available type still returns results.
    expect(groupOf(result.groups, 'knowledge_page')?.items.map((i) => i.id)).toEqual(['p1']);
    // The unavailable type is reported, not surfaced as a group.
    expect(groupOf(result.groups, 'document')).toBeUndefined();
    expect(result.unavailableTypes).toEqual(['document']);
  });

  it('reports every unavailable type when multiple sources are down', async () => {
    const pages = new FakeContentTypeSearcher('knowledge_page', [makeCandidate({ id: 'p1' })]);
    const docs = new FakeContentTypeSearcher('document', []);
    const messages = new FakeContentTypeSearcher('message', []);
    docs.setAvailable(false);
    messages.setAvailable(false);

    const service = new UnifiedSearchService({
      searchers: [pages, docs, messages],
      authorizer: new AllowAllAuthorizer(),
    });

    const result = await service.search('outage', makePrincipal());

    expect(result.unavailableTypes.sort()).toEqual(['document', 'message'].sort());
    expect(result.groups.map((g) => g.type)).toEqual(['knowledge_page']);
  });
});

describe('construction', () => {
  it('rejects two searchers registered for the same content type', () => {
    expect(
      () =>
        new UnifiedSearchService({
          searchers: [
            new FakeContentTypeSearcher('document', []),
            new FakeContentTypeSearcher('document', []),
          ],
          authorizer: new AllowAllAuthorizer(),
        }),
    ).toThrow(/already registered/);
  });

  it('exposes the searchable types in registration order', () => {
    const service = new UnifiedSearchService({
      searchers: [
        new FakeContentTypeSearcher('conversation', []),
        new FakeContentTypeSearcher('knowledge_chunk', []),
      ],
      authorizer: new AllowAllAuthorizer(),
    });
    expect(service.searchableTypes).toEqual(['conversation', 'knowledge_chunk']);
  });
});
