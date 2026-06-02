/**
 * Pure helpers for moving between the Chat_Service's persisted message content
 * ({@link ContentBlock}[]) and the flat text the Model_Router / providers and
 * the title generator consume.
 *
 * Persisted messages are ordered {@link ContentBlock}s (Req 44.6), but a model
 * request takes {@link ChatMessage} content (plain text or multimodal parts) and
 * title generation takes plain text. These helpers do that reduction
 * deterministically and without any I/O, so they are trivially unit-testable and
 * reused by both the send path (building the request) and the title path.
 */

import type { ChatChunk, ChatMessage, ChatRole, ContentBlock } from '@auxify/types';

import type { MessageRecord, MessageRole } from '../repositories/index.js';

/** A content-block payload that may carry text under a few common field names. */
interface TextBearingData {
  text?: unknown;
  code?: unknown;
  source?: unknown;
}

/**
 * Extract the plain text of a single {@link ContentBlock}, best-effort.
 *
 * Recognizes the common text-bearing payload fields (`text`, `code`, `source`)
 * used by the markdown/code/latex block shapes; blocks with no recognizable
 * text (tables, artifacts, search results) contribute nothing. This is a
 * lossy projection used only to build model context and title summaries, never
 * to render — rendering is the Output_Renderer's job.
 */
export function blockToText(block: ContentBlock): string {
  const data = block.data as TextBearingData | null | undefined;
  if (data === null || data === undefined) {
    return '';
  }
  if (typeof data.text === 'string') return data.text;
  if (typeof data.code === 'string') return data.code;
  if (typeof data.source === 'string') return data.source;
  return '';
}

/**
 * Flatten an ordered list of {@link ContentBlock}s to a single plain-text
 * string, joining non-empty block texts with blank lines.
 */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map(blockToText)
    .filter((text) => text !== '')
    .join('\n\n');
}

/**
 * Normalize a {@link ChatSendRequest}'s `content` (plain text or pre-built
 * blocks) into the {@link ContentBlock}[] persisted on the user message.
 *
 * A plain string becomes a single markdown block; an explicit block list is
 * passed through unchanged so callers retain full control of multimodal/rich
 * content.
 */
export function toContentBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === 'string') {
    return [{ type: 'markdown', data: { text: content } }];
  }
  return content;
}

/**
 * Concatenate the deltas of a provider's collected {@link ChatChunk}s into the
 * assistant's full response text (Req 4.2).
 */
export function chunksToText(chunks: ChatChunk[]): string {
  return chunks.map((chunk) => chunk.delta).join('');
}

/** Map a persisted {@link MessageRole} to the provider {@link ChatRole}. */
function toChatRole(role: MessageRole): ChatRole {
  // The persisted roles (user/assistant/system) are a subset of ChatRole.
  return role;
}

/**
 * Build the {@link ChatMessage} history a model request needs from persisted
 * message records, oldest first (Req 3, 4).
 *
 * Each record's content blocks are flattened to text; the resulting messages
 * are what the Chat_Service hands the Model_Router as the conversation so far.
 */
export function recordsToChatMessages(records: MessageRecord[]): ChatMessage[] {
  return records.map((record) => ({
    role: toChatRole(record.role),
    content: blocksToText(record.content),
  }));
}
