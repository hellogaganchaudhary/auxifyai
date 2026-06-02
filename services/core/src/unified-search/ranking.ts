/**
 * Pure scoring and ranking helpers for the Unified_Search_Service (Req 29.3,
 * 29.6).
 *
 * These functions carry the service's relevance math with no I/O, so they are
 * independently unit-testable and deterministic:
 *
 *  - {@link clamp01} bounds a score into `[0, 1]` so a misbehaving searcher can
 *    never push a result above or below the comparable range;
 *  - {@link hybridScore} combines a vector-similarity score and a keyword score
 *    under configurable weights into a single `[0, 1]` relevance score, the
 *    keyword-plus-vector ranking signal Req 29.6 requires;
 *  - {@link compareByScoreThenId} is the stable, deterministic order used to
 *    rank results within a content-type group by non-increasing relevance
 *    (Req 29.3), breaking ties on id so equal-scored results never reorder
 *    non-deterministically.
 */

/**
 * Clamp `value` into the `[0, 1]` relevance range.
 *
 * A non-finite input (NaN/Infinity from a misbehaving searcher) collapses to
 * `0` so it can never dominate ranking. Used on the keyword and vector
 * components before they are combined.
 *
 * @param value The raw score.
 * @returns `value` bounded to `[0, 1]`, or `0` when not finite.
 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

/**
 * Combine a vector-similarity score and a keyword score into a single hybrid
 * relevance score in `[0, 1]` (Req 29.6).
 *
 * The result is the weight-normalized convex combination
 * `(vw·vectorScore + kw·keywordScore) / (vw + kw)` over the clamped inputs, so
 * the output always lands in `[0, 1]` regardless of the chosen weights. When
 * both weights are zero (a degenerate configuration) it falls back to an even
 * average so a score is always produced. This is the single place the service
 * fuses keyword and vector relevance, so the keyword-plus-vector ranking
 * requirement is enforced uniformly across every content type.
 *
 * @param vectorScore The vector-similarity score (clamped into `[0, 1]`).
 * @param keywordScore The keyword-overlap score (clamped into `[0, 1]`).
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
  const vector = clamp01(vectorScore);
  const keyword = clamp01(keywordScore);
  const totalWeight = vectorWeight + keywordWeight;
  if (totalWeight <= 0) {
    return (vector + keyword) / 2;
  }
  return (vectorWeight * vector + keywordWeight * keyword) / totalWeight;
}

/** The minimal shape {@link compareByScoreThenId} ranks: a relevance score and a stable id. */
export interface Rankable {
  /** The combined hybrid relevance score in `[0, 1]` (Req 29.6). */
  readonly score: number;
  /** The result's stable id, used as the deterministic tie-break. */
  readonly id: string;
}

/**
 * Compare two results for non-increasing relevance order, breaking ties on id
 * (Req 29.3).
 *
 * Higher {@link Rankable.score} sorts first; equal scores fall back to ascending
 * id so the order is fully deterministic across equal-scored results (a
 * `localeCompare` so it is stable regardless of the input order). Suitable as
 * the comparator for `Array.prototype.sort`.
 *
 * @param a The first result.
 * @param b The second result.
 * @returns A negative number when `a` ranks before `b`, positive when after,
 *   and `0` only when both score and id are equal.
 */
export function compareByScoreThenId(a: Rankable, b: Rankable): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.id.localeCompare(b.id);
}
