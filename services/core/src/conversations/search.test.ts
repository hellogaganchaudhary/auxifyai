/**
 * Unit tests for the pure owner-scoped conversation search (Req 5.5).
 *
 * These verify case-insensitive containment matching across titles and message
 * content, the title-over-body ranking weight, the per-message increment, the
 * total tie-break order, and the blank-query no-match behaviour.
 */

import { describe, expect, it } from 'vitest';

import { makeConversationRecord, makeMessageRecord } from './fakes.js';
import { searchConversations, type SearchableConversation } from './search.js';
import { toConversation } from './types.js';

function item(
  id: string,
  title: string,
  bodies: string[] = [],
  updatedAt = '2026-01-01T00:00:00.000Z',
): SearchableConversation {
  return {
    conversation: toConversation(makeConversationRecord({ id, title, updatedAt })),
    messages: bodies.map((text, i) =>
      makeMessageRecord({ id: `${id}-m${i}`, content: [{ type: 'markdown', data: { text } }] }),
    ),
  };
}

describe('searchConversations', () => {
  it('matches the title case-insensitively', () => {
    const hits = searchConversations([item('c1', 'Budget Review')], 'budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.titleMatch).toBe(true);
  });

  it('matches message content and counts the matching messages', () => {
    const hits = searchConversations(
      [item('c1', 'Untitled', ['talk about the budget', 'more budget talk', 'unrelated'])],
      'budget',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.titleMatch).toBe(false);
    expect(hits[0]?.messageMatches).toBe(2);
  });

  it('ranks a title match above a body-only match', () => {
    const hits = searchConversations(
      [item('body', 'Untitled', ['budget budget budget']), item('title', 'Budget plan')],
      'budget',
    );
    expect(hits.map((h) => h.conversation.id)).toEqual(['title', 'body']);
  });

  it('breaks score ties by most-recent update then id', () => {
    const hits = searchConversations(
      [
        item('older', 'budget', [], '2026-01-01T00:00:00.000Z'),
        item('newer', 'budget', [], '2026-02-01T00:00:00.000Z'),
      ],
      'budget',
    );
    expect(hits.map((h) => h.conversation.id)).toEqual(['newer', 'older']);
  });

  it('excludes non-matching conversations', () => {
    const hits = searchConversations([item('c1', 'something else')], 'budget');
    expect(hits).toEqual([]);
  });

  it('returns nothing for a blank query', () => {
    expect(searchConversations([item('c1', 'budget')], '   ')).toEqual([]);
  });

  it('searches code block content too', () => {
    const items = [
      {
        conversation: toConversation(makeConversationRecord({ id: 'c1', title: 'x' })),
        messages: [
          makeMessageRecord({ content: [{ type: 'code', data: { code: 'const budget = 1' } }] }),
        ],
      },
    ];
    const hits = searchConversations(items, 'budget');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.messageMatches).toBe(1);
  });
});
