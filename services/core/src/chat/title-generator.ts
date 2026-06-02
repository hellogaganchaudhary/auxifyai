/**
 * Conversation title generation (Req 5.8).
 *
 * When a conversation has no user-assigned title after its first exchange (the
 * first user message plus the first assistant response), the Chat_Service
 * generates a title that summarizes the conversation. *How* that summary is
 * produced is intentionally pluggable behind the {@link TitleGenerator} port:
 *
 *   - production can inject a model-backed generator (a small prompt to a cheap
 *     model summarizing the exchange);
 *   - the default {@link DeterministicTitleGenerator} derives a concise title
 *     from the first user message with no model call, so the platform always has
 *     a sensible title and the behavior is fully testable with a fake.
 *
 * The generator only ever *proposes* a title; the Chat_Service decides whether
 * to apply it (never overwriting a user-assigned title — Req 5.8).
 */

import type { Principal } from '@auxify/types';

/**
 * The first exchange of a conversation, handed to a {@link TitleGenerator}
 * (Req 5.8).
 *
 * Both texts are already flattened to plain strings (multimodal parts reduced
 * to their text) so a generator never has to understand content-block shapes.
 */
export interface TitleSource {
  /** The conversation being titled. */
  conversationId: string;
  /** The first user message's text. */
  userText: string;
  /** The first assistant response's text. */
  assistantText: string;
}

/**
 * The injectable port that proposes a conversation title from its first
 * exchange (Req 5.8).
 *
 * Implementations may call a model or derive the title deterministically. They
 * receive the acting {@link Principal} so a model-backed generator can route
 * under the user's permissions, and they SHOULD return a short, single-line
 * summary; the Chat_Service still normalizes and length-caps the result before
 * persisting it.
 */
export interface TitleGenerator {
  /**
   * Propose a title summarizing the conversation's first exchange.
   *
   * @param source The first user message and assistant response.
   * @param principal The authenticated actor (for permission-scoped model calls).
   * @returns A proposed title; the caller normalizes and length-caps it.
   */
  generate(source: TitleSource, principal: Principal): Promise<string>;
}

/** The maximum length of a generated title, in characters. */
export const MAX_TITLE_LENGTH = 80 as const;

/** The fallback title used when the first exchange yields no usable text. */
export const FALLBACK_TITLE = 'New conversation' as const;

/**
 * Collapse runs of whitespace (including newlines) into single spaces and trim.
 *
 * Titles are single-line summaries, so internal newlines and repeated spaces
 * are normalized away before length-capping.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Normalize and length-cap a proposed title to a single line of at most
 * {@link MAX_TITLE_LENGTH} characters (Req 5.8).
 *
 * Whitespace is collapsed; if the result exceeds the cap it is truncated at a
 * word boundary where possible and an ellipsis (`…`) is appended. An
 * all-whitespace/empty proposal yields the {@link FALLBACK_TITLE}.
 *
 * @param proposed The raw title proposed by a {@link TitleGenerator} or derived.
 * @returns The cleaned, capped title to persist.
 */
export function normalizeTitle(proposed: string): string {
  const cleaned = normalizeWhitespace(proposed);
  if (cleaned === '') {
    return FALLBACK_TITLE;
  }
  if (cleaned.length <= MAX_TITLE_LENGTH) {
    return cleaned;
  }
  // Truncate to the cap, then back off to the last word boundary when one
  // exists reasonably close, so the title does not cut a word mid-character.
  const hardCut = cleaned.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = hardCut.lastIndexOf(' ');
  const body = lastSpace >= Math.floor(MAX_TITLE_LENGTH / 2) ? hardCut.slice(0, lastSpace) : hardCut;
  return `${body.trimEnd()}…`;
}

/**
 * A {@link TitleGenerator} that derives a title from the first user message with
 * no model call (Req 5.8).
 *
 * This is the always-available default: it summarizes by taking the first
 * sentence (or the leading words) of the user's message, normalized and
 * length-capped. It is deterministic, dependency-free, and the behavior a fake
 * in tests mirrors — while production may inject a model-backed generator
 * instead. The assistant text is available but unused here; a richer generator
 * can incorporate it.
 */
export class DeterministicTitleGenerator implements TitleGenerator {
  /**
   * Derive a concise title from the first user message.
   *
   * @param source The first exchange; only `userText` is used.
   * @param _principal The authenticated actor (unused here; a model-backed
   *   generator would route under it). Accepted to satisfy {@link TitleGenerator}.
   * @returns A normalized, length-capped first-sentence/leading-words summary.
   */
  async generate(source: TitleSource, _principal: Principal): Promise<string> {
    const text = normalizeWhitespace(source.userText);
    if (text === '') {
      return FALLBACK_TITLE;
    }
    // Prefer the first sentence; fall back to the whole (capped) text.
    const sentenceMatch = /^(.*?[.!?])(\s|$)/u.exec(text);
    const candidate = sentenceMatch?.[1] ?? text;
    return normalizeTitle(candidate);
  }
}
