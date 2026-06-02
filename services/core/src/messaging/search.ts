/**
 * Authorized message full-text ranking (Req 27.6).
 *
 * The Messaging_Service returns messages matching a query ranked by relevance
 * that the user is authorized to access. Authorization (which channels the user
 * may read) is resolved by the service against channel membership and
 * visibility (Req 27.8); this pure module only has to rank the
 * already-authorized candidate messages by a stable, sensible relevance score.
 *
 * Scoring (higher is more relevant):
 *   - each case-insensitive occurrence of the query in the body contributes a
 *     fixed weight, so a message mentioning the query more often ranks higher;
 *   - ties break by most-recent creation then id, so the order is total and
 *     deterministic.
 *
 * Matching is case-insensitive substring containment, which needs no provider
 * and is exhaustively testable. The platform's combined keyword + vector ranked
 * retrieval (Property 18) is the Unified_Search_Service's responsibility; this
 * is the Messaging_Service's own scoped ranking.
 */

import type { ChannelMessage, MessageSearchHit } from './types.js';

/** Weight contributed by each occurrence of the query in a message body. */
const OCCURRENCE_WEIGHT = 1;

/** Count non-overlapping occurrences of `needle` in `haystack` (both lowercased). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Rank authorized messages against a query by body relevance (Req 27.6).
 *
 * @param messages The already-authorized candidate messages.
 * @param query The user's full-text query.
 * @returns The matching hits, ranked by relevance (descending), then by most
 *   recent creation and id for a total, deterministic order. A blank query
 *   matches nothing.
 */
export function searchMessages(messages: ChannelMessage[], query: string): MessageSearchHit[] {
  const loweredQuery = query.trim().toLowerCase();
  if (loweredQuery.length === 0) return [];

  const hits: MessageSearchHit[] = [];
  for (const message of messages) {
    const occurrences = countOccurrences(message.body.toLowerCase(), loweredQuery);
    if (occurrences === 0) continue;
    hits.push({ message, score: occurrences * OCCURRENCE_WEIGHT });
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.message.createdAt !== b.message.createdAt) {
      return a.message.createdAt < b.message.createdAt ? 1 : -1;
    }
    if (a.message.id !== b.message.id) {
      return a.message.id < b.message.id ? -1 : 1;
    }
    return 0;
  });

  return hits;
}
