/**
 * Pure ranking and attribution helpers for the RAG_Retriever (Req 24.1, 24.2,
 * 24.4, 24.6).
 *
 * These functions carry the retriever's ranking math and attribution gate with
 * no I/O, so they are independently unit-testable and deterministic:
 *
 *  - {@link tokenize} normalizes text into a set of lower-cased word tokens;
 *  - {@link keywordScore} scores keyword overlap between a query and a chunk in
 *    `[0, 1]`, the keyword half of hybrid retrieval (Req 24.1);
 *  - {@link hybridScore} combines a vector-similarity score and a keyword score
 *    under configurable weights into a single `[0, 1]` relevance score that
 *    drives re-ranking and the top-K cut (Req 24.1, 24.2);
 *  - {@link hasCompleteAttribution} is the gate that excludes any chunk lacking
 *    complete source attribution (Req 24.6).
 */

import type { SourceAttribution } from '@auxify/types';

/** Matches runs of word characters (letters, digits, underscore) for tokenization. */
const WORD_PATTERN = /[\p{L}\p{N}_]+/gu;

/**
 * Split `text` into a set of lower-cased word tokens (Req 24.1).
 *
 * Punctuation and whitespace are dropped and case is folded so keyword overlap
 * is robust to formatting. Returns a Set so membership tests and intersection
 * are O(1) per term and duplicate terms do not inflate the score.
 *
 * @param text The text to tokenize.
 * @returns The distinct lower-cased word tokens in `text`.
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.toLowerCase().matchAll(WORD_PATTERN);
  for (const match of matches) {
    tokens.add(match[0]);
  }
  return tokens;
}

/**
 * Score the keyword overlap of a chunk against a query in `[0, 1]` (Req 24.1).
 *
 * Defined as the fraction of the query's distinct terms that also appear in the
 * chunk (term recall): `|queryTerms ∩ chunkTerms| / |queryTerms|`. A query with
 * no terms scores `0` (keyword search contributes nothing), and a chunk
 * containing every query term scores `1`.
 *
 * @param query The natural-language query.
 * @param chunkText The candidate chunk's text.
 * @returns The keyword-overlap score in `[0, 1]`.
 */
export function keywordScore(query: string, chunkText: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.size === 0) {
    return 0;
  }
  const chunkTerms = tokenize(chunkText);
  let overlap = 0;
  for (const term of queryTerms) {
    if (chunkTerms.has(term)) {
      overlap += 1;
    }
  }
  return overlap / queryTerms.size;
}

/**
 * Combine a vector-similarity score and a keyword score into a single hybrid
 * relevance score in `[0, 1]` (Req 24.1, 24.2).
 *
 * The result is the weight-normalized convex combination
 * `(vw·vectorScore + kw·keywordScore) / (vw + kw)`, so when both inputs are in
 * `[0, 1]` the output is too, regardless of the chosen weights. When both
 * weights are zero (a degenerate configuration) the function falls back to an
 * even average so a score is always produced.
 *
 * @param vectorScore The vector-similarity score in `[0, 1]`.
 * @param keywordScore The keyword-overlap score in `[0, 1]`.
 * @param vectorWeight The weight applied to {@link vectorScore} (>= 0).
 * @param keywordWeight The weight applied to {@link keywordScore} (>= 0).
 * @returns The combined hybrid relevance score in `[0, 1]`.
 */
export function hybridScore(
  vectorScore: number,
  keywordScore: number,
  vectorWeight: number,
  keywordWeight: number,
): number {
  const totalWeight = vectorWeight + keywordWeight;
  if (totalWeight <= 0) {
    return (vectorScore + keywordScore) / 2;
  }
  return (vectorWeight * vectorScore + keywordWeight * keywordScore) / totalWeight;
}

/**
 * True iff `attribution` is complete: a non-empty source id, source title,
 * location, and link (Req 24.4, 24.6).
 *
 * The RAG_Retriever injects a chunk into the model context only when this
 * returns `true`, so every cited chunk can always be traced back to its source
 * (Req 24.4) and a chunk with partial provenance is excluded (Req 24.6,
 * Property 32).
 *
 * @param attribution The attribution to validate (possibly `undefined`).
 * @returns `true` when all four attribution fields are present and non-empty.
 */
export function hasCompleteAttribution(
  attribution: SourceAttribution | undefined,
): attribution is SourceAttribution {
  if (attribution === undefined || attribution === null) {
    return false;
  }
  return (
    isNonEmptyString(attribution.sourceId) &&
    isNonEmptyString(attribution.sourceTitle) &&
    isNonEmptyString(attribution.location) &&
    isNonEmptyString(attribution.link)
  );
}

/** True iff `value` is a string with at least one non-whitespace character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
