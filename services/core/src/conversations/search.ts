/**
 * Basic owner-scoped conversation full-text search (Req 5.5).
 *
 * The Conversation_Manager provides a simple, deterministic contains-ranking
 * over a conversation's title and its messages' textual content, scoped to the
 * conversations the owner is authorized to access (the tenant-scoped owner
 * listing). This is intentionally modest: the platform's authorized, combined
 * keyword + vector ranked retrieval (Property 18, task 12.6) is the
 * Unified_Search_Service's responsibility — richer ranking is unified-search
 * territory. This module only has to return matching conversations ranked by a
 * stable, sensible relevance score.
 *
 * Scoring (higher is more relevant):
 *   - a title match contributes a fixed, higher weight than a body match
 *     (titles are the strongest signal),
 *   - each message whose content contains the query adds an incremental weight,
 *   - ties break by most-recent update then id, so the order is total.
 *
 * Matching is case-insensitive substring containment, which needs no provider
 * and is exhaustively testable.
 */

import type { ContentBlock } from '@auxify/types';

import type { Conversation, Message, SearchHit } from './types.js';

/** Weight contributed by a title match (the strongest relevance signal). */
const TITLE_WEIGHT = 10;

/** Weight contributed by each message whose content matches the query. */
const MESSAGE_WEIGHT = 1;

/** Pull a lowercase plain-text rendering of a content block for matching. */
function blockText(block: ContentBlock): string {
  const data = block.data;
  if (typeof data === 'string') return data;
  if (data !== null && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.code === 'string') return record.code;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

/** Whether a message's combined content contains the (already-lowercased) query. */
function messageMatches(message: Message, loweredQuery: string): boolean {
  const text = message.content.map(blockText).join('\n').toLowerCase();
  return text.includes(loweredQuery);
}

/** A conversation paired with the messages used to search its body. */
export interface SearchableConversation {
  conversation: Conversation;
  messages: Message[];
}

/**
 * Rank conversations against a query across titles and message content
 * (Req 5.5).
 *
 * @param items The owner-authorized conversations, each with its messages.
 * @param query The user's full-text query.
 * @returns The matching hits, ranked by relevance (descending), then by most
 *   recent update and id for a total, deterministic order. A blank query
 *   matches nothing.
 */
export function searchConversations(items: SearchableConversation[], query: string): SearchHit[] {
  const loweredQuery = query.trim().toLowerCase();
  if (loweredQuery.length === 0) return [];

  const hits: SearchHit[] = [];
  for (const { conversation, messages } of items) {
    const titleMatch = conversation.title.toLowerCase().includes(loweredQuery);
    const matchingMessages = messages.filter((m) => messageMatches(m, loweredQuery));
    const messageCount = matchingMessages.length;
    if (!titleMatch && messageCount === 0) continue;

    const score = (titleMatch ? TITLE_WEIGHT : 0) + messageCount * MESSAGE_WEIGHT;
    hits.push({ conversation, score, titleMatch, messageMatches: messageCount });
  }

  hits.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.conversation.updatedAt !== b.conversation.updatedAt) {
      return a.conversation.updatedAt < b.conversation.updatedAt ? 1 : -1;
    }
    if (a.conversation.id !== b.conversation.id) {
      return a.conversation.id < b.conversation.id ? -1 : 1;
    }
    return 0;
  });

  return hits;
}
