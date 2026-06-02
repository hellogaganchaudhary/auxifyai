/**
 * Unit tests for the pure message ranking core (Req 27.6).
 *
 * `searchMessages` ranks already-authorized messages by body relevance; these
 * cover the occurrence-weighted scoring, the total deterministic tie-break, and
 * the blank-query and no-match edge cases. Authorization (which messages are
 * candidates) is the Messaging_Service's concern and is covered there.
 */

import { describe, expect, it } from 'vitest';

import { makeChannelMessage } from './fakes.js';
import { searchMessages } from './search.js';

describe('searchMessages (Req 27.6)', () => {
  it('ranks by number of query occurrences, descending', () => {
    const a = makeChannelMessage({ id: 'a', body: 'budget' });
    const b = makeChannelMessage({ id: 'b', body: 'budget budget budget' });
    const c = makeChannelMessage({ id: 'c', body: 'budget budget' });

    const hits = searchMessages([a, b, c], 'budget');
    expect(hits.map((h) => h.message.id)).toEqual(['b', 'c', 'a']);
    expect(hits.map((h) => h.score)).toEqual([3, 2, 1]);
  });

  it('is case-insensitive', () => {
    const a = makeChannelMessage({ id: 'a', body: 'The BUDGET Report' });
    const hits = searchMessages([a], 'budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.score).toBe(1);
  });

  it('excludes non-matching messages', () => {
    const a = makeChannelMessage({ id: 'a', body: 'unrelated text' });
    const b = makeChannelMessage({ id: 'b', body: 'mentions budget' });
    const hits = searchMessages([a, b], 'budget');
    expect(hits.map((h) => h.message.id)).toEqual(['b']);
  });

  it('returns nothing for a blank query', () => {
    const a = makeChannelMessage({ id: 'a', body: 'budget' });
    expect(searchMessages([a], '   ')).toEqual([]);
  });

  it('breaks score ties by most-recent creation then id', () => {
    const older = makeChannelMessage({
      id: 'older',
      body: 'budget',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = makeChannelMessage({
      id: 'newer',
      body: 'budget',
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    const hits = searchMessages([older, newer], 'budget');
    expect(hits.map((h) => h.message.id)).toEqual(['newer', 'older']);
  });
});
