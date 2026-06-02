/**
 * Pure ranking core for the Prompt_Library analytics report (Req 10.7).
 *
 * Given the Organization's templates, {@link computePromptAnalytics} produces
 * the three ranked lists the report exposes — most-used (by `usageCount`),
 * highest-rated (by `ratingAvg`), and most-shared (by `shareCount`) — each
 * sorted descending by its metric with a stable, deterministic tie-break on
 * template id, and truncated to `limit`. Keeping this pure (no I/O) makes the
 * ranking exhaustively unit-testable and reused unchanged by the service.
 */

import {
  DEFAULT_ANALYTICS_LIMIT,
  type PromptAnalytics,
  type PromptAnalyticsEntry,
  type PromptTemplate,
} from './types.js';

/** Rank templates by `metric` descending (ties broken by id) and take `limit`. */
function rankBy(
  templates: readonly PromptTemplate[],
  metric: (t: PromptTemplate) => number,
  limit: number,
): PromptAnalyticsEntry[] {
  return [...templates]
    .sort((a, b) => {
      const diff = metric(b) - metric(a);
      if (diff !== 0) return diff;
      // Deterministic tie-break so equal metrics yield a stable ordering.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, Math.max(0, limit))
    .map((t) => ({ templateId: t.id, title: t.title, metric: metric(t) }));
}

/**
 * Compute the most-used, highest-rated, and most-shared rankings for a set of
 * templates (Req 10.7).
 *
 * @param templates The Organization's templates to rank.
 * @param limit Maximum entries per list. Defaults to {@link DEFAULT_ANALYTICS_LIMIT}.
 * @returns The three ranked lists, each descending by its metric.
 */
export function computePromptAnalytics(
  templates: readonly PromptTemplate[],
  limit: number = DEFAULT_ANALYTICS_LIMIT,
): PromptAnalytics {
  return {
    mostUsed: rankBy(templates, (t) => t.usageCount, limit),
    highestRated: rankBy(templates, (t) => t.ratingAvg, limit),
    mostShared: rankBy(templates, (t) => t.shareCount, limit),
  };
}
