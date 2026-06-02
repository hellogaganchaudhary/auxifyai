/**
 * Deterministic recent-first date grouping for conversation listing (Req 5.2 /
 * Property 17).
 *
 * The Conversation_Manager returns a user's conversations *ordered by most
 * recent update and grouped by date*. This module is the pure core of that
 * behaviour, separated so it is exhaustively testable on its own:
 *
 *   - {@link groupByDate} takes conversations already sorted most-recent-update
 *     first and partitions them into contiguous {@link ConversationGroup}s by
 *     UTC calendar day, preserving the input order within and across groups
 *     (so the groups themselves are also most-recent-first).
 *   - {@link dayKey} derives the stable `YYYY-MM-DD` UTC day key, and
 *     {@link dateLabel} derives the human label (`Today`/`Yesterday`/date)
 *     relative to an injected "now", so labelling is deterministic in tests.
 *
 * Grouping is by UTC day to be timezone-deterministic; the relative
 * `Today`/`Yesterday` labels are computed against the same UTC day as `now`.
 */

import type { Conversation, ConversationGroup } from './types.js';

/** Milliseconds in one day. */
const MS_PER_DAY = 86_400_000;

/**
 * The stable `YYYY-MM-DD` UTC day key for an ISO-8601 timestamp.
 *
 * @param isoTimestamp An ISO-8601 timestamp (e.g. a conversation's `updatedAt`).
 * @returns The `YYYY-MM-DD` calendar day in UTC.
 */
export function dayKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    // An unparseable timestamp groups under a stable sentinel rather than
    // throwing, so a single bad row never breaks the whole listing.
    return 'unknown';
  }
  return date.toISOString().slice(0, 10);
}

/** The whole-day difference (in UTC days) between two `YYYY-MM-DD` keys. */
function dayDifference(fromKey: string, toKey: string): number {
  const from = Date.parse(`${fromKey}T00:00:00.000Z`);
  const to = Date.parse(`${toKey}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return Number.NaN;
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * The human-readable label for a day key relative to `now`.
 *
 * `now`'s UTC day yields `Today`, the prior UTC day yields `Yesterday`, and any
 * other day yields the `YYYY-MM-DD` key itself.
 *
 * @param key The `YYYY-MM-DD` day key to label.
 * @param now The reference instant (injected for deterministic tests).
 */
export function dateLabel(key: string, now: Date): string {
  if (key === 'unknown') return 'Unknown';
  const todayKey = now.toISOString().slice(0, 10);
  const diff = dayDifference(key, todayKey);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return key;
}

/**
 * Partition conversations (already most-recent-update first) into contiguous
 * date groups by UTC day, preserving order within and across groups (Req 5.2 /
 * Property 17).
 *
 * The input MUST be pre-sorted most-recent first; this function does not
 * re-sort, so the caller controls the ordering invariant (the manager sorts by
 * `updatedAt` DESC, then `createdAt` DESC, then `id` for a total, stable order).
 * Because the input is sorted, all conversations of a given day are contiguous,
 * so a single linear pass produces at most one group per day with groups in
 * most-recent-day-first order.
 *
 * @param conversations Conversations sorted most-recent-update first.
 * @param now The reference instant for `Today`/`Yesterday` labels.
 * @returns The date-grouped listing, most-recent group first.
 */
export function groupByDate(conversations: Conversation[], now: Date): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  let current: ConversationGroup | undefined;

  for (const conversation of conversations) {
    const key = dayKey(conversation.updatedAt);
    if (current === undefined || current.date !== key) {
      current = { dateLabel: dateLabel(key, now), date: key, conversations: [] };
      groups.push(current);
    }
    current.conversations.push(conversation);
  }

  return groups;
}

/**
 * The total ordering comparator for the conversation list (Req 5.2).
 *
 * Sorts most-recent-update first, breaking ties by `createdAt` (DESC) and
 * finally by `id` (ASC) so the order is *total and deterministic* even when two
 * conversations share an `updatedAt` — the property test relies on this being a
 * stable, well-defined order rather than depending on input order.
 */
export function compareRecentFirst(a: Conversation, b: Conversation): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
