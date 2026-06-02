/**
 * Unit tests for the pure recent-first date-grouping core (Req 5.2).
 *
 * These pin down `dayKey`, `dateLabel`, `compareRecentFirst`, and `groupByDate`
 * with concrete examples and edge cases (Today/Yesterday/date labels, contiguous
 * grouping of a pre-sorted list, total ordering on equal timestamps, and the
 * unparseable-timestamp sentinel). The over-all-inputs ordering invariant lives
 * in the companion property test.
 */

import { describe, expect, it } from 'vitest';

import { compareRecentFirst, dateLabel, dayKey, groupByDate } from './date-grouping.js';
import { makeConversationRecord } from './fakes.js';
import { toConversation } from './types.js';

const NOW = new Date('2026-03-15T12:00:00.000Z');

function conv(id: string, updatedAt: string, createdAt = updatedAt) {
  return toConversation(makeConversationRecord({ id, updatedAt, createdAt }));
}

describe('dayKey', () => {
  it('extracts the YYYY-MM-DD UTC day', () => {
    expect(dayKey('2026-03-15T23:59:59.000Z')).toBe('2026-03-15');
  });

  it('returns the unknown sentinel for an unparseable timestamp', () => {
    expect(dayKey('not-a-date')).toBe('unknown');
  });
});

describe('dateLabel', () => {
  it('labels the current UTC day as Today', () => {
    expect(dateLabel('2026-03-15', NOW)).toBe('Today');
  });

  it('labels the prior UTC day as Yesterday', () => {
    expect(dateLabel('2026-03-14', NOW)).toBe('Yesterday');
  });

  it('labels any other day with its date key', () => {
    expect(dateLabel('2026-03-10', NOW)).toBe('2026-03-10');
  });

  it('labels the unknown sentinel as Unknown', () => {
    expect(dateLabel('unknown', NOW)).toBe('Unknown');
  });
});

describe('compareRecentFirst', () => {
  it('orders the more recent update first', () => {
    const a = conv('a', '2026-03-15T10:00:00.000Z');
    const b = conv('b', '2026-03-14T10:00:00.000Z');
    expect(compareRecentFirst(a, b)).toBeLessThan(0);
    expect(compareRecentFirst(b, a)).toBeGreaterThan(0);
  });

  it('breaks updatedAt ties by createdAt then id for a total order', () => {
    const a = conv('a', '2026-03-15T10:00:00.000Z', '2026-03-15T09:00:00.000Z');
    const b = conv('b', '2026-03-15T10:00:00.000Z', '2026-03-15T08:00:00.000Z');
    // Same updatedAt; a was created later, so a sorts first.
    expect(compareRecentFirst(a, b)).toBeLessThan(0);

    const c = conv('c', '2026-03-15T10:00:00.000Z', '2026-03-15T09:00:00.000Z');
    const d = conv('d', '2026-03-15T10:00:00.000Z', '2026-03-15T09:00:00.000Z');
    // Same updatedAt and createdAt; break by id ascending.
    expect(compareRecentFirst(c, d)).toBeLessThan(0);
  });
});

describe('groupByDate', () => {
  it('partitions a pre-sorted list into contiguous most-recent-first groups', () => {
    const sorted = [
      conv('t2', '2026-03-15T11:00:00.000Z'),
      conv('t1', '2026-03-15T07:00:00.000Z'),
      conv('y1', '2026-03-14T08:00:00.000Z'),
      conv('o1', '2026-03-10T08:00:00.000Z'),
    ];
    const groups = groupByDate(sorted, NOW);

    expect(groups.map((g) => g.dateLabel)).toEqual(['Today', 'Yesterday', '2026-03-10']);
    expect(groups[0]?.conversations.map((c) => c.id)).toEqual(['t2', 't1']);
    expect(groups.map((g) => g.date)).toEqual(['2026-03-15', '2026-03-14', '2026-03-10']);
  });

  it('returns no groups for an empty list', () => {
    expect(groupByDate([], NOW)).toEqual([]);
  });
});
